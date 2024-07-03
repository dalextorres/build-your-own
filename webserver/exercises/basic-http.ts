import * as url from "url";
import * as http from "http";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to calculate factorial
const factorial = (n) => {
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
};

const server = http.createServer((req, res) => {
  const reqUrl = url.parse(req.url, true);

  const startTime = Date.now();

  if (reqUrl.pathname === "/sum" && req.method === "GET") {
    const parsedNum = reqUrl.query.number;

    if (typeof parsedNum !== "string") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid number\n");
    }

    const number = parseInt(parsedNum as string, 10);
    if (isNaN(number) || number < 0) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid number\n");
    } else {
      const result = factorial(number);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`Factorial of ${number} is ${result}\n`);
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found\n");
  }

  const endTime = Date.now();

  console.log(`Request took ${endTime - startTime}ms`);
});

server.listen(8080, () => {
  console.log("Server listening on port 8080");
});
