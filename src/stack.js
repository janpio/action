const {
  EC2Client,
  DescribeVpcsCommand,
  CreateVpcCommand,
  DescribeSubnetsCommand,
  CreateSubnetCommand,
  ModifySubnetAttributeCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeInternetGatewaysCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  DescribeRouteTablesCommand,
  CreateRouteCommand
} = require("@aws-sdk/client-ec2");
const { STACK_NAME, STACK_TAGS, STACK_FILTERS } = require('./constants');
const { defaultProvider } = require("@aws-sdk/credential-provider-node");

// Initialize EC2 Client
const ec2Client = new EC2Client({ credentials: defaultProvider() });

// Function to find existing VPC
async function findVPC() {
  const command = new DescribeVpcsCommand({
    Filters: STACK_FILTERS
  });

  try {
    const response = await ec2Client.send(command);
    return response.Vpcs.length > 0 ? response.Vpcs[0] : null;
  } catch (error) {
    console.error("⚠️ Error finding VPC:", error);
    return null;
  }
}

// Function to create a VPC
async function createVPC() {
  const command = new CreateVpcCommand({
    CidrBlock: "10.0.0.0/16",
    TagSpecifications: [
      {
        ResourceType: "vpc",
        Tags: [{ Key: "Name", Value: `${STACK_NAME}-vpc` }, ...STACK_TAGS]
      }
    ]
  });
  try {
    const vpcResponse = await ec2Client.send(command);
    console.log("✅ VPC Created:", vpcResponse.Vpc.VpcId);
    return vpcResponse.Vpc;
  } catch (error) {
    console.error("Error creating VPC:", error);
    throw new Error("❌ Error creating VPC");
  }
}

// Function to find existing Subnet
async function findSubnet(vpcId) {
  const command = new DescribeSubnetsCommand({
    Filters: [
      {
        Name: "vpc-id",
        Values: [vpcId]
      },
      ...STACK_FILTERS
    ]
  });

  try {
    const response = await ec2Client.send(command);
    return response.Subnets.length > 0 ? response.Subnets[0] : null;
  } catch (error) {
    console.error("⚠️ Error finding Subnet:", error);
    return null;
  }
}

// Function to create a Subnet
async function createSubnet(vpcId) {
  const command = new CreateSubnetCommand({
    VpcId: vpcId, CidrBlock: "10.0.1.0/24",
    TagSpecifications: [
      {
        ResourceType: "subnet",
        Tags: [{ Key: "Name", Value: `${STACK_NAME}-subnet` }, ...STACK_TAGS]
      }
    ]
  });
  try {
    const subnetResponse = await ec2Client.send(command);
    console.log("✅ Subnet Created:", subnetResponse.Subnet.SubnetId);
    return subnetResponse.Subnet;
  } catch (error) {
    console.error("Error creating Subnet:", error);
    throw new Error("❌ Error creating Subnet");
  }
}

// Function to create an Internet Gateway
async function createInternetGateway() {
  const command = new CreateInternetGatewayCommand({
    TagSpecifications: [
      {
        ResourceType: "internet-gateway",
        Tags: [{ Key: "Name", Value: `${STACK_NAME}-igw` }, ...STACK_TAGS]
      }
    ]
  });
  try {
    const igwResponse = await ec2Client.send(command);
    console.log("✅ Internet Gateway Created:", igwResponse.InternetGateway.InternetGatewayId);
    return igwResponse.InternetGateway;
  } catch (error) {
    console.error("❌ Error creating Internet Gateway:", error);
    throw new Error("❌ Error creating Internet Gateway");
  }
}

async function findInternetGateway(vpcId) {
  const command = new DescribeInternetGatewaysCommand({
    Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }, ...STACK_FILTERS]
  });

  try {
    const response = await ec2Client.send(command);
    return response.InternetGateways.length > 0 ? response.InternetGateways[0] : null;
  } catch (error) {
    console.error("⚠️ Error finding Internet Gateway:", error);
    return null;
  }
}

// Function to attach Internet Gateway to VPC
async function attachInternetGateway(vpcId, igwId) {
  const command = new AttachInternetGatewayCommand({
    InternetGatewayId: igwId,
    VpcId: vpcId
  });
  try {
    await ec2Client.send(command);
    console.log("✅ Internet Gateway attached to VPC:", vpcId);
  } catch (error) {
    console.error("❌ Error attaching Internet Gateway:", error);
    throw new Error("❌ Error attaching Internet Gateway");
  }
}

// Function to modify the route table
async function modifyRouteTable(vpcId, igwId) {
  // Find the main route table associated with the VPC
  const describeRouteTablesCommand = new DescribeRouteTablesCommand({
    Filters: [
      {
        Name: "vpc-id",
        Values: [vpcId]
      },
      {
        Name: "association.main",
        Values: ["true"]
      }
    ]
  });

  try {
    const routeTableResponse = await ec2Client.send(describeRouteTablesCommand);
    const routeTableId = routeTableResponse.RouteTables[0].RouteTableId;

    // Create a route in the route table that points to the Internet Gateway
    const createRouteCommand = new CreateRouteCommand({
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: igwId,
      RouteTableId: routeTableId
    });
    await ec2Client.send(createRouteCommand);
    console.log("✅ Route to Internet Gateway added in Route Table:", routeTableId);
  } catch (error) {
    console.error("Error modifying Route Table:", error);
    throw new Error("❌ Error modifying Route Table");
  }
}

// Function to find existing Security Group
async function findSecurityGroup(vpcId) {
  const command = new DescribeSecurityGroupsCommand({
    Filters: [
      {
        Name: "vpc-id",
        Values: [vpcId]
      },
      ...STACK_FILTERS
    ]
  });

  try {
    const response = await ec2Client.send(command);
    return response.SecurityGroups.length > 0 ? response.SecurityGroups[0] : null;
  } catch (error) {
    console.error("⚠️ Error finding Security Group:", error);
    return null;
  }
}


// Function to create a Security Group
async function createSecurityGroup(vpcId) {
  const command = new CreateSecurityGroupCommand({
    Description: `Security group for ${STACK_NAME} stack`,
    GroupName: `${STACK_NAME}-sg`,
    VpcId: vpcId,
    TagSpecifications: [
      {
        ResourceType: "security-group",
        Tags: [{ Key: "Name", Value: `${STACK_NAME}-sg` }, ...STACK_TAGS]
      }
    ]
  });

  try {
    const securityGroupResponse = await ec2Client.send(command);
    const groupId = securityGroupResponse.GroupId;
    console.log("✅ Security Group Created:", groupId);

    // Set Ingress Rule for SSH
    const ingressCommand = new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: "0.0.0.0/0" }]
        }
      ]
    });
    await ec2Client.send(ingressCommand);
    console.log("✅ Ingress rule for SSH added to Security Group:", groupId);

    return securityGroupResponse;
  } catch (error) {
    console.error("Error creating Security Group:", error);
    throw new Error("❌ Error creating Security Group");
  }
}

async function findOrCreateVpc() {
  const vpc = await findVPC();
  if (vpc) {
    console.log(`✅ Existing VPC found: ${vpc.VpcId}`);
    return vpc;
  } else {
    console.log("⚠️ No existing VPC found, creating a new one...");
    return await createVPC();
  }
}

async function findOrCreateInternetGateway(vpc) {
  let igw = await findInternetGateway(vpc.VpcId);
  if (igw) {
    console.log(`✅ Existing Internet Gateway found: ${igw.InternetGatewayId}`);
  } else {
    console.log("⚠️ No existing Internet Gateway found, creating a new one...");
    igw = await createInternetGateway();
    await attachInternetGateway(vpc.VpcId, igw.InternetGatewayId);
    await modifyRouteTable(vpc.VpcId, igw.InternetGatewayId);
  }
  return igw;
}

async function findOrCreateSubnet(vpc) {
  let subnet = await findSubnet(vpc.VpcId);
  if (subnet) {
    console.log(`✅ Existing Subnet found: ${subnet.SubnetId}`);
  } else {
    console.log("⚠️ No existing Subnet found, creating a new one...");
    subnet = await createSubnet(vpc.VpcId);
  }

  const modifySubnetCommand = new ModifySubnetAttributeCommand({
    SubnetId: subnet.SubnetId,
    MapPublicIpOnLaunch: { Value: true }
  });
  await ec2Client.send(modifySubnetCommand);
  console.log("✅ MapPublicIpOnLaunch set to true for subnet:", subnet.SubnetId);

  return subnet;
}

async function findOrCreateSecurityGroup(vpc) {
  let securityGroup = await findSecurityGroup(vpc.VpcId);
  if (securityGroup) {
    console.log(`✅ Existing Security Group found: ${securityGroup.GroupId}`);
  } else {
    console.log("⚠️ No existing Security Group found, creating a new one...");
    securityGroup = await createSecurityGroup(vpc.VpcId);
  }
  return securityGroup;
}

// Main function
async function setupStack() {
  const vpc = await findOrCreateVpc();
  const igw = await findOrCreateInternetGateway(vpc);
  const subnet = await findOrCreateSubnet(vpc);
  const securityGroup = await findOrCreateSecurityGroup(vpc);

  return {
    vpc, igw, subnet, securityGroup
  }
}

module.exports = { setupStack };
