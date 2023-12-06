const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");

let octokit;
let owner;
let repo;
let baseUrl;

async function fetchCollaboratorsWithWriteAccess() {
  const collaborators = await octokit.repos.listCollaborators({
    owner,
    repo,
    permission: 'push',
    affiliation: 'all'
  });

  return collaborators.data
    .map(user => user.login);
}

async function fetchPublicSSHKeys(usernames) {
  let sshKeys = [];

  for (const username of usernames) {
    const keys = await octokit.users.listPublicKeysForUser({
      username
    });
    sshKeys.push(...keys.data.map(key => key.key));
  }

  return sshKeys;
}

async function setupOctokitForRepository(appId, appPrivateKey) {
  const appOctokit = new Octokit({ authStrategy: createAppAuth, baseUrl, auth: { appId, privateKey: appPrivateKey } });
  let installationId;

  const installations = await appOctokit.apps.listInstallations();
  for (const installation of installations.data) {
    if (installation.account.login === owner) {
      installationId = installation.id;
      break;
    }
  }

  if (installationId) {
    console.log(`✅ GitHub App installation found for ${owner}`);
  } else {
    throw new Error(`❌ GitHub App installation not found for ${owner}`);
  }

  // Initialize Octokit with the installation ID
  octokit = new Octokit({
    authStrategy: createAppAuth,
    baseUrl,
    auth: {
      appId: appId,
      privateKey: appPrivateKey,
      installationId: installationId,
    },
  });

  const accessibleRepos = await octokit.apps.listReposAccessibleToInstallation();
  if (accessibleRepos.data.repositories.find(repository => repository.name === repo)) {
    console.log("✅ Repository is accessible to the GitHub App installation");
  } else {
    throw new Error(`❌ Repository is not accessible to the GitHub App installation`);
  }
}

async function registerRunner(label) {
  const response = await octokit.request('POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig', {
    owner,
    repo,
    name: label,
    runner_group_id: 1,
    labels: [label],
  });

  const jitToken = response.data.encoded_jit_config;

  console.log("✅ Runner registered with GitHub App installation");

  return jitToken;
}

async function setupGitHub(appId, appPrivateKey, { baseUrl }) {
  // Get owner and repo from environment variables
  [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  baseUrl = baseUrl;

  if (!owner || !repo) {
    throw new Error('❌ Repository information is missing');
  }

  await setupOctokitForRepository(appId, appPrivateKey)

  return { owner, repo, octokit };
}

module.exports = { setupGitHub, fetchCollaboratorsWithWriteAccess, fetchPublicSSHKeys, registerRunner }