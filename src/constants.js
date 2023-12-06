const STACK_NAME = process.env['INPUT_STACK-NAME'] || "runs-on";
const STACK_TAGS = [{ Key: "stack", Value: STACK_NAME }, { Key: "provider", Value: "runs-on.com" }];
const STACK_FILTERS = [{ Name: "tag:stack", Values: [STACK_NAME] }];
const SUPPORTED_RUNNER_OSES = ["ubuntu22"];
const SUPPORTED_RUNNER_ARCHES = ["x64"];

module.exports = { STACK_NAME, STACK_TAGS, STACK_FILTERS, SUPPORTED_RUNNER_ARCHES, SUPPORTED_RUNNER_OSES }