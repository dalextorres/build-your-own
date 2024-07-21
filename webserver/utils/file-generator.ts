import { writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const numLines = 200;
const lineLength = 20;
const filename = "req2.txt";

const generateRandomString = (length: number) => {
  return randomBytes(length).toString("base64").slice(0, length);
};

const generateLargeTextFile = (filename: string) => {
  const lines: string[] = [];
  for (let i = 0; i < numLines; i++) {
    lines.push(generateRandomString(lineLength));
  }
  const filePath = join(__dirname, "..", "resources", filename);
  writeFileSync(filePath, lines.join("\n"));
};

console.log(`Generating ${numLines} lines of random data into ${filename}...`);
generateLargeTextFile(filename);
console.log("File generation completed.");
