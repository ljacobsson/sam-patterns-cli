const { findFilesWithExtension } = require('../../../../../shared/fileFinder');
const fs = require('fs');

function findConstructs() {
  const rootDir = '.';
  const fileExtension = '.py';
  const searchString = /from aws_cdk import/g;
  const files = findFilesWithExtension(rootDir, fileExtension);
  const matchedFiles = [];

  files.forEach((file) => {
    const fileContent = fs.readFileSync(file, 'utf8');

    if (fileContent.match(searchString)) {
      matchedFiles.push(file);
    }
  });

  return matchedFiles;
}


module.exports = {
  findConstructs
};