### Testing

Run the following to generate a test file:

```
ts-node file-generator.ts
```

\*Note, you have to modify the numLines and lineLength fields

Now run the following command to verify your server is using constant memory and doesn't OOM:

```
curl -s --data-binary @{file_path} http://127.0.0.1:1234/{uri} | shasum
```

\*Note, shasum works for macOS systems, you can also test your program by removing this command but it'll generate a print equal to the size of your file on your terminal.
