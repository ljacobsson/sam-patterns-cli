const { SFNClient, TestStateCommand, DescribeStateMachineCommand, ListExecutionsCommand, GetExecutionHistoryCommand } = require('@aws-sdk/client-sfn');
const { CloudFormationClient, ListStackResourcesCommand } = require('@aws-sdk/client-cloudformation');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { fromSSO } = require("@aws-sdk/credential-provider-sso");
const samConfigParser = require('../../shared/samConfigParser');
const parser = require('../../shared/parser');
const fs = require('fs');
const inputUtil = require('../../shared/inputUtil');
const clc = require("cli-color");
const path = require('path');
const { Spinner } = require('cli-spinner');

const os = require('os');
let clientParams;
async function run(cmd) {
    const config = await samConfigParser.parse();
    const credentials = await fromSSO({ profile: cmd.profile || config.profile || 'default' });
    clientParams = { credentials, region: cmd.region || config.region }
    const sfnClient = new SFNClient(clientParams);
    const cloudFormation = new CloudFormationClient(clientParams);
    const sts = new STSClient(clientParams);
    const template = await parser.findSAMTemplateFile(process.cwd());
    const templateContent = fs.readFileSync(template, 'utf8');
    const templateObj = parser.parse("template", templateContent);
    const stateMachines = findAllStateMachines(templateObj);
    const stateMachine = stateMachines.length === 1 ? stateMachines[0] : await inputUtil.list("Select state machine", stateMachines);

    const spinner = new Spinner(`Fetching state machine ${stateMachine}... %s`);
    spinner.setSpinnerString(30);
    spinner.start();

    const stackResources = await listAllStackResourcesWithPagination(cloudFormation, cmd.stackName || config.stack_name);

    const stateMachineArn = stackResources.find(r => r.LogicalResourceId === stateMachine).PhysicalResourceId;
    const stateMachineRoleName = stackResources.find(r => r.LogicalResourceId === `${stateMachine}Role`).PhysicalResourceId;

    const describedStateMachine = await sfnClient.send(new DescribeStateMachineCommand({ stateMachineArn }));
    const definition = JSON.parse(describedStateMachine.definition);

    spinner.stop(true);
    const states = findStates(definition);
    const state = await inputUtil.autocomplete("Select state", states.map(s => { return { name: s.key, value: { name: s.key, state: s.state } } }));

    const input = await getInput(stateMachineArn, state.name, describedStateMachine.type);

    const accountId = (await sts.send(new GetCallerIdentityCommand({}))).Account;
    console.log(`Invoking state ${clc.green(state.name)} with input:\n${clc.green(input)}\n`);
    const testResult = await sfnClient.send(new TestStateCommand(
        {
            definition: JSON.stringify(state.state),
            roleArn: `arn:aws:iam::${accountId}:role/${stateMachineRoleName}`,
            input: input
        }
    ));
    delete testResult.$metadata;
    let color = "green";
    if (testResult.error) {
        color = "red";
    }
    for (const key in testResult) {
        console.log(`${clc[color](key.charAt(0).toUpperCase() + key.slice(1))}: ${testResult[key]}`);
    }
}

async function getInput(stateMachineArn, state, stateMachineType) {
    let types = [
        "Empty JSON",
        "Manual input",
        "From file"];

    if (stateMachineType === "STANDARD") {
        types.push("From recent execution");
    }
    
    const configDirExists = fs.existsSync(path.join(os.homedir(), '.samp-cli', 'state-tests'));
    if (!configDirExists) {
        fs.mkdirSync(path.join(os.homedir(), '.samp-cli', 'state-tests'), { recursive: true });
    }

    const stateMachineStateFileExists = fs.existsSync(path.join(os.homedir(), '.samp-cli', 'state-tests', stateMachineArn));

    if (!stateMachineStateFileExists) {
        fs.writeFileSync(path.join(os.homedir(), '.samp-cli', 'state-tests', stateMachineArn), "{}");
    }

    const storedState = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.samp-cli', 'state-tests', stateMachineArn), "utf8"));
    if (Object.keys(storedState).length > 0) {
        types = ["Latest input", ...types];
    }

    const type = await inputUtil.list("Select input type", types);

    if (type === "Empty JSON") {
        return "{}";
    }

    if (type === "Manual input") {
        return inputUtil.text("Enter input JSON", "{}");
    }

    if (type === "From file") {
        const file = await inputUtil.file("Select input file", "json");
        return fs.readFileSync(file, "utf8");
    }

    if (type === "Latest input") {
        return JSON.stringify(storedState[state]);
    }

    if (type === "From recent execution") {
        const sfnClient = new SFNClient(clientParams);

        const executions = await sfnClient.send(new ListExecutionsCommand({ stateMachineArn }));
        const execution = await inputUtil.autocomplete("Select execution", executions.executions.map(e => { return { name: `[${e.startDate.toLocaleTimeString()}] ${e.name}`, value: e.executionArn } }));
        const executionHistory = await sfnClient.send(new GetExecutionHistoryCommand({ executionArn: execution }));
        const input = findFirstTaskEnteredEvent(executionHistory, state);
        if (!input) {
            console.log("No input found for state. Did it execute in the chosen execution?");
            process.exit(1);
        }
        return input.stateEnteredEventDetails.input;
    }
}

function findFirstTaskEnteredEvent(jsonData, state) {
    console.log("state", state);
    for (const event of jsonData.events) {
        if (event.type.endsWith("StateEntered") && event.stateEnteredEventDetails.name === state) {
            return event;
        }
    }
    return null; // or any appropriate default value
}


function findStates(aslDefinition) {
    const result = [];

    function traverseStates(states) {
        Object.keys(states).forEach(key => {
            const state = states[key];
            if (state.Type === 'Task' || state.Type === 'Pass' || state.Type === 'Choice') {
                result.push({ key, state });
            }
            // Recursively search in Parallel and Map structures
            if (state.Type === 'Parallel' && state.Branches) {
                state.Branches.forEach(branch => {
                    traverseStates(branch.States);
                });
            }
            if (state.Type === 'Map' && state.ItemProcessor && state.ItemProcessor.States) {
                traverseStates(state.ItemProcessor.States);
            }
        });
    }

    traverseStates(aslDefinition.States);
    return result;
}

function listAllStackResourcesWithPagination(cloudFormation, stackName) {
    const params = {
        StackName: stackName
    };
    const resources = [];
    const listStackResources = async (params) => {
        const response = await cloudFormation.send(new ListStackResourcesCommand(params));
        resources.push(...response.StackResourceSummaries);
        if (response.NextToken) {
            params.NextToken = response.NextToken;
            await listStackResources(params);
        }
    };
    
    return listStackResources(params).then(() => resources);
}

function findAllStateMachines(templateObj) {
    const stateMachines = Object.keys(templateObj.Resources).filter(r => templateObj.Resources[r].Type === "AWS::Serverless::StateMachine");
    if (stateMachines.length === 0) {
        console.log("No state machines found in template");
        process.exit(0);
    }

    return stateMachines;
}

module.exports = {
    run
}