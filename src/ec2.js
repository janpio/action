const { EC2Client } = require("@aws-sdk/client-ec2");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { DescribeInstancesCommand, DescribeInstanceTypesCommand, DescribeInstanceStatusCommand, DescribeImagesCommand, RunInstancesCommand, waitUntilInstanceRunning, TerminateInstancesCommand } = require("@aws-sdk/client-ec2");
const { STACK_TAGS } = require("./constants");

// Initialize EC2 Client
const ec2Client = new EC2Client({ credentials: defaultProvider() });

async function findImageId(os, arch) {
  const archMapping = {
    x64: "x86_64",
  }
  // Fetch the most recent AMI
  const describeImagesParams = {
    Filters: [
      { Name: "name", Values: [`runner-${os}-*`] },
      // Architecture: "i386" || "x86_64" || "arm64" || "x86_64_mac" || "arm64_mac",
      { Name: "architecture", Values: [archMapping[arch]] },
      { Name: "state", Values: ["available"] }
    ],
    Owners: ['135269210855']
  };
  const imagesCommand = new DescribeImagesCommand(describeImagesParams);
  const images = await ec2Client.send(imagesCommand);

  if (images.Images.length === 0) {
    throw new Error(`❌ No AMIs found for ${os} ${arch}`);
  }

  // Sort to find the most recent one
  images.Images.sort((a, b) => b.Name.localeCompare(a.Name));

  const { ImageId, Name } = images.Images[0];
  console.log(`✅ Latest AMI ID: ${ImageId} (${Name})`);

  return ImageId;
}

async function checkInstanceStore(instanceType) {
  try {
    // Describe the instance type to get information about its instance store volumes
    const describeInstanceTypesCommand = new DescribeInstanceTypesCommand({
      InstanceTypes: [instanceType],
    });

    const response = await ec2Client.send(describeInstanceTypesCommand);
    const instanceTypeInfo = response.InstanceTypes[0];
    return instanceTypeInfo.InstanceStorageSupported;
  } catch (err) {
    console.error('Error:', err);
    return false;
  }
}

async function createEC2Instance({ dryRun = false, useSpotInstances, storageType, storageIops, storageSize, instanceTypes, instanceName, imageId, subnetId, securityGroupId, userData }) {
  // Create the instance
  let instanceParams = {
    SubnetId: subnetId,
    SecurityGroupIds: [securityGroupId],
    ImageId: imageId,
    MinCount: 1,
    MaxCount: 1,
    // NetworkInterfaces: [
    //   {
    //     DeviceIndex: 0,
    //     SecurityGroupIds: [securityGroupId],
    //     SubnetId: subnetId, // Replace with your subnet ID
    //     AssociatePublicIpAddress: true,
    //     // Tags for the network interface
    //     TagSpecifications: [
    //       {
    //         ResourceType: 'network-interface',
    //         Tags: TAGS
    //       }
    //     ]
    //   }
    // ],
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: instanceName }, ...STACK_TAGS
      ]
    }],
    // Setting this to true, even though most instances don't care - https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-optimized.html
    EbsOptimized: true,
    InstanceInitiatedShutdownBehavior: 'terminate',
    UserData: Buffer.from(userData).toString('base64'),
    BlockDeviceMappings: [{
      DeviceName: '/dev/sda1', // Device name for the root volume
      Ebs: {
        VolumeSize: storageSize, // Size of the root EBS volume in GB
        VolumeType: storageType,
      },
      TagSpecifications: [{ ResourceType: 'volume', Tags: STACK_TAGS }]
    }]
  };

  if (["io2", "io1"].includes(storageType) && storageIops > 0) {
    instanceParams.BlockDeviceMappings[0].Ebs.Iops = storageIops;
  }

  if (useSpotInstances) {
    console.log(`→ Using spot instances`);
    instanceParams.InstanceMarketOptions = {
      MarketType: 'spot',
      SpotOptions: {
        // max price per hour, but will use the min availabe price at the time of request
        MaxPrice: "2.0",
        SpotInstanceType: 'one-time',
        InstanceInterruptionBehavior: 'terminate'
      }
    }
  }

  // Try each instance type until one is successfully created
  for (const instanceType of instanceTypes) {
    const hasInstanceStore = await checkInstanceStore(instanceTypes[0])
    if (hasInstanceStore) {
      instanceParams.BlockDeviceMappings = [
        {
          DeviceName: '/dev/sdb', // Device name for the instance store volume
          VirtualName: 'ephemeral0', // Name used internally by AWS for the instance store volume,
          TagSpecifications: [{ ResourceType: 'volume', Tags: STACK_TAGS }]
        },
        ...instanceParams.BlockDeviceMappings
      ]
    }

    try {
      console.log(`→ Attempting to create instance with type ${instanceType}...`);
      instanceParams.InstanceType = instanceType;
      const runCommand = new RunInstancesCommand(instanceParams);
      if (dryRun) {
        console.log(`→ Not launching instance since dry-run=true`);
        return null;
      } else {
        const instanceResponse = await ec2Client.send(runCommand);
        const instance = instanceResponse.Instances[0];
        console.log(`✅ EC2 Instance created with ID: ${instance.InstanceId} and type ${instanceType}`);
        return instance;
      }
    } catch (error) {
      console.warn(`⚠️ Failed to create instance with type ${instanceType}: ${error}.`);
    }
  }

  throw new Error("❌ Failed to create instance with any of the provided instance types");
}

async function fetchInstanceDetails(instanceId) {
  // Define the parameters for the DescribeInstances command
  const params = {
    Filters: [
      {
        Name: "instance-id",
        Values: [instanceId],
      },
    ],
  };

  // Fetch the instance details
  const describeInstancesCommand = new DescribeInstancesCommand(params);
  const data = await ec2Client.send(describeInstancesCommand)
  const instances = data.Reservations.flatMap((reservation) =>
    reservation.Instances
  );
  if (instances.length > 0) {
    return instances[0];
  } else {
    throw new Error(`❌ No instances found with ID ${instanceId}`);
  }
}
// waitForStatusChecks is false by default, since it takes much longer to say OK vs reality of runner being connected to GitHub
async function waitForInstance(instanceId, waitForStatusChecks = false) {
  console.log(`→ Waiting for instance ${instanceId} to be in running state...`);

  try {
    // First, wait until the instance is in a running state
    await waitUntilInstanceRunning({ client: ec2Client, maxWaitTime: 300 }, { InstanceIds: [instanceId] });
    console.log(`✅ EC2 Instance is now running.`);

    if (waitForStatusChecks) {
      // Now check the instance status
      let instanceOk = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!instanceOk) {
        if (attempts > maxAttempts) {
          throw new Error(`❌ Instance ${instanceId} did not pass status checks after 10 attempts.`);
        }
        attempts++;
        const status = await ec2Client.send(new DescribeInstanceStatusCommand({ InstanceIds: [instanceId] }));
        const instanceStatuses = status.InstanceStatuses;

        if (instanceStatuses.length > 0 && instanceStatuses[0].InstanceStatus.Status === 'ok' && instanceStatuses[0].SystemStatus.Status === 'ok') {
          instanceOk = true;
          console.log(`Instance ${instanceId} is running and status checks passed.`);
        } else {
          console.log(`[${attempts}/${maxAttempts}] Waiting for instance ${instanceId} status checks to pass...`);
          await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds before checking again
        }
      }
    }
  } catch (error) {
    console.error(`❌ Error waiting for instance to run and pass status checks: ${error}`);
    throw error;
  }
}

async function terminateInstance(instanceId) {
  if (!instanceId) {
    console.log('No instance ID available to terminate.');
    return;
  }

  console.log(`Terminating EC2 instance with ID: ${instanceId}`);
  const terminateCommand = new TerminateInstancesCommand({ InstanceIds: [instanceId] });
  await ec2Client.send(terminateCommand);
  console.log(`Instance ${instanceId} terminated.`);
}

module.exports = { findImageId, createEC2Instance, fetchInstanceDetails, waitForInstance, terminateInstance }