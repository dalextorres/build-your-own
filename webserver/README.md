# Web Server

This repository contains the code created by following the [BYO Web Server](https://build-your-own.org/webserver/) book.

This web server implements the HTTP protocol to handle client requests, it's purpose is to understand a web server's internal functionality and its not meant to be ran in a production environment.

## Running the server

Install dependencies:

```
npm install
```

Run the server:

```
ts-node http-server-v1.ts
```

### Testing

Open another tab in your terminal and run the following commands to test the web server's functionality.

To test a regular POST http request, with Content-Type defined:

```
curl -s --data-binary "{message}" http://127.0.0.1:1234/{uri}
```

To test an http request with chunked encoding:

```
curl -T- http://127.0.0.1:1234/echo
```

To verify the server is using constant memory and won't OOM with large requests, do the following:

1. Run the following to generate a test file:

```
ts-node utils/file-generator.ts
```

\*Note, you have to modify the numLines and lineLength fields to generate large text files

2. Now run the following command with a large text file:

```
curl -s --data-binary @{file_path} http://127.0.0.1:1234/{uri} | shasum
```

\*Note, shasum works for macOS systems, didn't test in other OS's.
