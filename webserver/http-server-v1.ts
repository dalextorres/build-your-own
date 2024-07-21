import * as net from "net";
import { DynBuf, bufPop, bufPush } from "./utils/dynamic-buffer";
import { TCPConn, soInit, soRead, soWrite } from "./utils/socket";

// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// custom error class for HTTP errors
class HTTPError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HTTPError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, HTTPError.prototype);
  }
}

// parsed HTTP request header
type HTTPReq = {
  method: string;
  uri: Buffer;
  version: string;
  headers: Buffer[];
};

// http response
type HTTPRes = {
  code: number;
  headers: Buffer[];
  body: BodyReader;
};

// split the buffer by '\r\n', zero copy.
function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let cur = 0;
  while (cur < data.length) {
    const idx = data.indexOf("\r\n", cur);
    console.assert(idx >= 0);
    lines.push(data.subarray(cur, idx));
    cur = idx + 2;
  }
  return lines;
}

// GET URI HTTP/1.1
function parseRequestLine(line: Buffer): [string, Buffer, string] {
  if (line.length === 0) {
    throw new HTTPError(400, "empty request line");
  }

  const parts = line.toString("latin1").split(" ");
  if (parts.length !== 3) {
    throw new HTTPError(400, "bad request line");
  }
  const method = parts[0];
  const uri = Buffer.from(parts[1]);
  const version = parts[2];

  if (!(uri.length && uri[0] === "/".charCodeAt(0))) {
    throw new HTTPError(400, "bad request line");
  }
  // TODO: validate URI
  if (!version.startsWith("HTTP/")) {
    throw new HTTPError(400, "bad request line");
  }
  const versionN = version.slice("HTTP/".length);
  return [method, uri, versionN];
}

function validateHeader(line: Buffer): boolean {
  const colon = line.indexOf(":");
  if (colon < 1) {
    return false;
  }
  if (line.indexOf("\n") >= 0) {
    return false;
  }
  // TODO: https://www.rfc-editor.org/rfc/rfc9110.html#section-5
  return true;
}

// parse an HTTP request header
function parseHTTPReq(data: Buffer): HTTPReq {
  // split the data into lines
  const lines: Buffer[] = splitLines(data);
  // the first line is `METHOD URI VERSION`
  const [method, uri, version] = parseRequestLine(lines[0]);
  // followed by header fields in the format of `Name: value`
  const headers: Buffer[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const h = Buffer.from(lines[i]); // copy
    if (!validateHeader(h)) {
      throw new HTTPError(400, "bad field");
    }
    headers.push(h);
  }
  // the header ends by an empty line
  console.assert(lines[lines.length - 1].length === 0);
  return {
    method: method,
    uri: uri,
    version: version,
    headers: headers,
  };
}

// parse & remove a header from the beginning of the buffer if possible
function cutMessage(buf: DynBuf): null | HTTPReq {
  // the end of the header is marked by '\r\n\r\n'
  const idx = buf.data.subarray(0, buf.length).indexOf("\r\n\r\n");
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen) {
      throw new HTTPError(413, "header is too large");
    }
    return null; // need more data
  }
  // parse & remove the header
  const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

function fieldGet(headers: Buffer[], key: string): null | Buffer {
  for (const h of headers) {
    const [name, value] = h.toString("latin1").toLowerCase().split(":");
    if (name === key.toLowerCase()) {
      return Buffer.from(value.trim());
    }
  }

  return null;
}

// status code to status message
const kStatusMessage: { [key: number]: string } = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Time-out",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Request Entity Too Large",
  414: "Request-URI Too Large",
  415: "Unsupported Media Type",
  416: "Requested range not satisfiable",
  417: "Expectation Failed",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Time-out",
  505: "HTTP Version not supported",
};

// encode the response header
function encodeHTTPResp(msg: HTTPRes): Buffer {
  const res: Buffer[] = [];
  // status line
  console.assert(100 <= msg.code && msg.code <= 999, "bad status code");
  const status = kStatusMessage[msg.code] || "???";
  const line = `HTTP/1.1 ${msg.code} ${status}\r\n`;
  res.push(Buffer.from(line));
  // header fields
  const crlf = Buffer.from("\r\n");
  for (const h of msg.headers) {
    console.assert(validateHeader(h));
    // header + crlf according to http protocol
    res.push(h);
    res.push(crlf);
  }
  // empty line, a double crlf marks the end of the header
  res.push(crlf);
  return Buffer.concat(res);
}

// send an HTTP response through the socket
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
  if (resp.body.length < 0) {
    throw new Error("TODO: chunked encoding");
  }
  // set the "Content-Length" field
  console.assert(!fieldGet(resp.headers, "Content-Length"));
  resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
  // write the header
  await soWrite(conn, encodeHTTPResp(resp));
  // write the body
  while (true) {
    const data = await resp.body.read();
    if (data.length === 0) {
      break;
    }
    await soWrite(conn, data);
  }
}

// an interface for reading/writing data from/to the HTTP body.
type BodyReader = {
  // the "Content-Length", -1 if unknown.
  length: number;
  // read data. returns an empty buffer after EOF.
  read: () => Promise<Buffer>;
};

// BodyReader from in-memory data
function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async (): Promise<Buffer> => {
      if (done) {
        return Buffer.from(""); // no more data
      } else {
        done = true;
        return data;
      }
    },
  };
}

// BodyReader from a socket with a known length
function readerFromConnLength(
  conn: TCPConn,
  buf: DynBuf,
  remain: number
): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> => {
      if (remain === 0) {
        return Buffer.from(""); // done
      }
      if (buf.length === 0) {
        // try to get some data if there is none
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0) {
          // expect more data!
          throw new Error("Unexpected EOF from HTTP body");
        }
      }
      // consume data from the buffer
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return data;
    },
  };
}

// parses a decimal number. returns NaN if failed.
function parseDec(s: string): number {
  for (const ch of s) {
    if (!("0" <= ch && ch <= "9")) {
      return NaN; // parseInt() accepts more formats
    }
  }
  return parseInt(s, 10);
}

// BodyReader from an HTTP request
function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
  let bodyLen = -1;
  const contentLen = fieldGet(req.headers, "Content-Length");
  if (contentLen) {
    bodyLen = parseDec(contentLen.toString("latin1"));
    if (isNaN(bodyLen)) {
      throw new HTTPError(400, "bad Content-Length.");
    }
  }
  const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");
  const chunked =
    fieldGet(req.headers, "Transfer-Encoding")?.equals(
      Buffer.from("chunked")
    ) || false;
  if (!bodyAllowed && (bodyLen > 0 || chunked)) {
    throw new HTTPError(400, "HTTP body not allowed.");
  }
  if (!bodyAllowed) {
    bodyLen = 0;
  }

  if (bodyLen >= 0) {
    // "Content-Length" is present
    return readerFromConnLength(conn, buf, bodyLen);
  } else if (chunked) {
    // chunked encoding
    throw new HTTPError(501, "TODO");
  } else {
    // read the rest of the connection
    throw new HTTPError(501, "TODO");
  }
}

// a sample request handler
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
  // act on the request URI
  let resp: BodyReader;
  switch (req.uri.toString("latin1")) {
    case "/echo":
      // http echo server
      resp = body;
      break;
    default:
      resp = readerFromMemory(Buffer.from("hello world.\n"));
      break;
  }

  return {
    code: 200,
    headers: [Buffer.from("Server: my_first_http_server")],
    body: resp,
  };
}

async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  while (true) {
    // try to get 1 request header from the buffer
    const msg: null | HTTPReq = cutMessage(buf);
    if (!msg) {
      // need more data
      const data = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length === 0 && buf.length === 0) {
        return; // no more requests
      }
      if (data.length === 0) {
        throw new HTTPError(400, "Unexpected EOF.");
      }
      // got some data, try it again.
      continue;
    }

    // process the message and send the response
    const reqBody: BodyReader = readerFromReq(conn, buf, msg);
    const res: HTTPRes = await handleReq(msg, reqBody);
    await writeHTTPResp(conn, res);
    // close the connection for HTTP/1.0
    if (msg.version === "1.0") {
      return;
    }
    // make sure that the request body is consumed completely,
    // the handleReq may have ignored the body if the request URI is not present in the defined endpoints
    // if we don't read the full body we'll have the parser at the wrong position (pointer to buffer) for the next request
    while ((await reqBody.read()).length > 0) {
      /* empty */
    }
  } // loop for IO
}

async function newConn(socket: net.Socket): Promise<void> {
  const conn: TCPConn = soInit(socket);
  try {
    await serveClient(conn);
  } catch (exc) {
    console.error("exception:", exc);
    if (exc instanceof HTTPError) {
      // intended to send an error response
      const resp: HTTPRes = {
        code: exc.statusCode,
        headers: [],
        body: readerFromMemory(Buffer.from(exc.message + "\n")),
      };
      try {
        await writeHTTPResp(conn, resp);
      } catch (exc) {
        /* ignore */
      }
    }
  } finally {
    socket.destroy();
  }
}

const server = net.createServer({
  pauseOnConnect: true, // required by `TCPConn`
  allowHalfOpen: true, // required for transmitting after EOF.
  noDelay: true,
});
server.on("error", (err: Error) => {
  throw err;
});
server.on("connection", newConn);
server.listen({ host: "127.0.0.1", port: 1234 });
