
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { setupStack } = require('./stack');
const { setupGitHub, registerRunner, fetchPublicSSHKeys, fetchCollaboratorsWithWriteAccess } = require('./github');
const { findImageId, createEC2Instance, waitForInstance, fetchInstanceDetails } = require("./ec2");
const { SUPPORTED_RUNNER_OSES, SUPPORTED_RUNNER_ARCHES } = require('./constants');

let actionInputs = {};

// Get the current directory of the file being executed
const currentDirectory = __dirname;
const parentDirectory = path.resolve(currentDirectory, '..');
const actionYmlPath = path.join(parentDirectory, 'action.yml');

// transform input names from foo-bar to fooBar
function transformInputName(inputName) {
  const words = inputName.split('-');
  for (let i = 1; i < words.length; i++) {
    words[i] = words[i][0].toUpperCase() + words[i].slice(1);
  }
  return words.join('');
}

// Read the action YAML file to find input default values and types
const yamlFile = fs.readFileSync(actionYmlPath, 'utf8');
const { inputs } = yaml.load(yamlFile);
for (const inputName in inputs) {
  if (inputs.hasOwnProperty(inputName)) {
    const input = inputs[inputName];
    const value = core.getInput(inputName) || input.default;
    if (input.description.includes("Whether")) { // boolean
      actionInputs[transformInputName(inputName)] = value === "true";
    } else if (input.description.includes("Comma-separated")) { // array
      actionInputs[transformInputName(inputName)] = value.split(',');
    } else {
      actionInputs[transformInputName(inputName)] = value;
    }
  }
}

function generateRandomLabel() {
  return `runs-on-aws-${Math.random().toString(36).substring(2, 15)}`;
}

function generateUserData({ runnerJitConfig, sshKeys, runnerLabel, runnerAgentVersion }) {
  // Prepare user-data script
  const userData = `#!/bin/bash
set -e ; set -o pipefail

# automatically shut down instance after job exits
cleanup() {
	echo "Going to shut down in a few seconds..."
  sleep 1m
  shutdown -h now
}
trap cleanup EXIT INT TERM

echo "Removing useless stuff..."
rm -rf /etc/cron.d/* /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.monthly/* /etc/cron.weekly/*
systemctl stop e2scrub_all e2scrub_all.timer || true
# we don't care since these are ephemeral runners
if [ -f /usr/lib/ubuntu-release-upgrader/check-new-release ]; then
  echo "" > /usr/lib/ubuntu-release-upgrader/check-new-release
fi

echo "Setting up hostname..."
hostnamectl set-hostname ${runnerLabel}
echo '127.0.0.1 ${runnerLabel}' >> /etc/hosts

AGENT_USER=ubuntu
AGENT_DIR=/opt/runner
AGENT_FULL_TIMEOUT=12h
AGENT_WAIT_TIMEOUT=20m
AGENT_VERSION=${runnerAgentVersion}

echo "Setting up SSH access..."
mkdir -p /home/$AGENT_USER/.ssh && chown $AGENT_USER:$AGENT_USER /home/$AGENT_USER
echo "${sshKeys.join('\n')}" >> /home/$AGENT_USER/.ssh/authorized_keys
chown -R $AGENT_USER:$AGENT_USER /home/$AGENT_USER/.ssh
chmod 700 /home/$AGENT_USER/.ssh && chmod 600 /home/$AGENT_USER/.ssh/authorized_keys
usermod -aG docker $AGENT_USER

echo "Installing watchdogs..."
sleep $AGENT_WAIT_TIMEOUT && \
  if ! ( grep "ProcessChannel" $AGENT_DIR/_diag/*.log | grep "Receiving message" ) ; then echo "Wait timeout reached. Shutting down instance." && cleanup ; fi &

sleep $AGENT_FULL_TIMEOUT && \
  echo "Full timeout reached. Shutting down instance." && cleanup &

echo "Making sure docker works..."
time docker ps

echo "Installing agent..."
mkdir -p $AGENT_DIR
time curl -o actions-runner-linux-x64-$AGENT_VERSION.tar.gz -L https://github.com/actions/runner/releases/download/v$AGENT_VERSION/actions-runner-linux-x64-$AGENT_VERSION.tar.gz
time tar xzf ./actions-runner-linux-x64-$AGENT_VERSION.tar.gz -C $AGENT_DIR
#time tar xzf $(find /opt/runner-cache/ -type f) -C $AGENT_DIR
chown -R $AGENT_USER:$AGENT_USER $AGENT_DIR

echo "Launching agent..."
su - $AGENT_USER -c "cd $AGENT_DIR  && ./run.sh --jitconfig ${runnerJitConfig}"
`;

  return userData;
}

async function main() {
  if (actionInputs.runnerTypes.length === 0) {
    throw new Error('❌ No runner types specified');
  }
  if (!actionInputs.imageId || actionInputs.imageId === "") {
    if (!SUPPORTED_RUNNER_OSES.includes(actionInputs.runnerOs)) {
      throw new Error(`❌ Unsupported runner OS: ${actionInputs.runnerOs}. Must be one of ${SUPPORTED_RUNNER_OSES.join(', ')}`);
    }
    if (!SUPPORTED_RUNNER_ARCHES.includes(actionInputs.runnerArch)) {
      throw new Error(`❌ Unsupported runner Arch: ${actionInputs.runnerArch}. Must be one of ${SUPPORTED_RUNNER_ARCHES.join(', ')}`);
    }
    actionInputs.imageId = await findImageId(actionInputs.runnerOs, actionInputs.runnerArch)
  }

  await setupGitHub(actionInputs.githubAppId, actionInputs.githubAppPrivateKey, { baseUrl: actionInputs.githubBaseUrl })
  const { subnet, securityGroup } = await setupStack();

  let index = actionInputs.admins.indexOf('@collaborators/push')
  if (index !== -1) {
    actionInputs.admins = actionInputs.admins.splice(index, index)
    actionInputs.admins.push(...(await fetchCollaboratorsWithWriteAccess()));
  }
  console.log(`→ Admins: ${actionInputs.admins.join(', ')}`);
  const sshKeys = await fetchPublicSSHKeys(actionInputs.admins);

  // Step 1: Register a new self-hosted runner with GitHub API
  const runnerLabel = generateRandomLabel();
  console.log(`→ Runner label: ${runnerLabel}`);

  const runnerJitConfig = await registerRunner(runnerLabel);
  const userData = generateUserData({ runnerJitConfig, sshKeys, runnerLabel, runnerAgentVersion: actionInputs.runnerAgentVersion })

  const { useSpotInstances, storageType, storageIops, storageSize, runnerTypes, imageId, dryRun } = actionInputs;
  // Step 2: Spawn a new EC2 instance
  const instance = await createEC2Instance({
    useSpotInstances, storageType, storageIops, storageSize,
    instanceTypes: runnerTypes,
    instanceName: runnerLabel,
    securityGroupId: securityGroup.GroupId,
    subnetId: subnet.SubnetId,
    imageId,
    userData,
    dryRun
  });

  if (instance) {
    // Step 3: Wait until the EC2 instance is running
    await waitForInstance(instance.InstanceId);

    const { PublicIpAddress, InstanceType, InstanceId } = await fetchInstanceDetails(instance.InstanceId);

    core.setOutput("runner-label", runnerLabel);
    core.setOutput("runner-instance-id", InstanceId);
    core.setOutput("runner-instance-ipv4", PublicIpAddress);
    core.setOutput("runner-instance-type", InstanceType);
  } else if (dryRun) {
    console.log("✅ Dry run successful");
  } else {
    throw new Error("❌ Error creating EC2 instance");
  }
}

main().catch(error => {
  console.error(error);
  core.setFailed(`❌ ${error}`)
});