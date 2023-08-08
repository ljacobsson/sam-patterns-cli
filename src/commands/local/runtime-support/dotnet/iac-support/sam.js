const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { findSAMTemplateFile, parse } = require('../../../../../shared/parser');

async function setup() {
  const projectReferenceTemplate = '<ProjectReference Include="..\%code_uri%.csproj" />';
  const template = parse("template", fs.readFileSync(findSAMTemplateFile('.')).toString());

  // fetch all functions
  const functions = Object.keys(template.Resources).filter(key => template.Resources[key].Type === "AWS::Serverless::Function");
  const codeURIs = functions.map(f => {
    const props = template.Resources[f].Properties
    const codeUri = (props.CodeUri || template.Globals.Function.CodeUri + "/").replace(/\/\//g, "/");
    const project = props.Handler.split("::")[0];
    return `\\${codeUri}\\${project}`;
  });

  const uniqueCodeURIs = [...new Set(codeURIs)];
  console.log('Copying dotnet project');
  fs.cpSync(`${__dirname}/../../../runtime-support/dotnet`, `.samp-out/`, { recursive: true });

  let csproj = fs.readFileSync(`.samp-out/dotnet.csproj`, 'utf8');

  for (const codeUri of uniqueCodeURIs) {
    csproj = csproj.replace("<!-- Projects -->", projectReferenceTemplate.replace("%code_uri%", codeUri) + "\n<!-- Projects -->");
  }
  csproj = csproj.replace("<!-- Projects -->", "");
  fs.writeFileSync(`.samp-out/dotnet.csproj`, csproj);

  await run();
}


async function run(initialised) {
  try {
    //process.env.outDir = ".samp-out";
    await copyAppsettings();

    const dotnetProcess = exec(`dotnet build .samp-out/dotnet.csproj`, {});
    dotnetProcess.stderr.on('data', (data) => print(data));
    dotnetProcess.stdout.on('data', (data) => {
      console.log("dotnet: ", data.toString().replace(/\n$/, ''));
      if (data.toString().includes("Time Elapsed") && !initialised) {
        initialised = true;
        const childProcess = exec(`node ${__dirname}../../../../runner.js run`, {});
        childProcess.stdout.on('data', (data) => print(data));
        childProcess.stderr.on('data', (data) => print(data));
      }
    });
    return initialised;
  } catch (error) {
    console.log(error);
  }
}

function print(data) {
  if (!process.env.muteParentOutput) {
    console.error(data.toString().replace(/\n$/, ''));
  }
}

const findAppSettingsJson = async (folderPath = ".") => {
  try {
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const fileStat = fs.statSync(filePath);

      if (fileStat.isDirectory()) {
        const appSettingsPath = await findAppSettingsJson(filePath);
        if (appSettingsPath) {
          return appSettingsPath;
        }
      } else if (file === 'appsettings.json') {
        return filePath;
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
};

async function copyAppsettings() {
  const dir = process.cwd();
  const sourceFilePath = await findAppSettingsJson(dir);
  if (sourceFilePath) {
    const destinationPath = path.join(dir, '.samp-out', 'appsettings.json');

    try {
      fs.copyFileSync(sourceFilePath, destinationPath);
      console.log('appsettings.json copied successfully!');
    } catch (err) {
    }
  };
}

module.exports = {
  setup
};