import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";

const accountId = aws.getCallerIdentity().then(identity => identity.accountId);
const domainName = "api.tommybradbury.co.uk";
const certificateArn = "arn:aws:acm:eu-west-2:140293477718:certificate/dc46af13-b4c4-4759-bf96-5b5b04444b4f";
const brefPhpLayerArn = "arn:aws:lambda:eu-west-2:534081306603:layer:php-84-fpm:34";

const role = new aws.iam.Role("lambdaRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});
new aws.iam.RolePolicyAttachment("lambdaPolicyAttachment", {
  role: role,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

const api = new aws.apigatewayv2.Api("httpApi", {
  protocolType: "HTTP",
  name: "api.tommybradbury.co.uk-auth-service",
});

function createBrefFunction(name: string, zipFileName: string, description: string) {
  const fn = new aws.lambda.Function(name, {
    name,
    code: new pulumi.asset.FileArchive(path.join(process.cwd(), "lambda_code", zipFileName)),
    runtime: "provided.al2",
    architectures: ["x86_64"], // or ["arm64"] if you choose arm64 layers
    handler: "index.php",
    role: role.arn,
    memorySize: 256,
    timeout: 10,
    layers: [brefPhpLayerArn],
    publish: true,
    tags: { Name: name, Description: description },
  });

  const alias = new aws.lambda.Alias(`${name}DevAlias`, {
    functionName: fn.name,
    functionVersion: fn.version,
    name: "dev",
  }, { dependsOn: [fn] });

  // Permission for this API to invoke the alias
  new aws.lambda.Permission(`${name}ApiGatewayPermission`, {
    action: "lambda:InvokeFunction",
    function: alias.arn, // grant to alias specifically
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`arn:aws:execute-api:${aws.config.region}:${accountId}:${api.id}/*/*`,
  }, { dependsOn: [alias, api] });

  return { fn, alias };
}

const authService = createBrefFunction("AuthServiceLambda", "lambda-auth.zip", "Handles /auth/ route");

const authIntegration = new aws.apigatewayv2.Integration("authIntegration", {
  apiId: api.id,
  integrationType: "AWS_PROXY",
  integrationUri: authService.alias.invokeArn, // alias invoke ARN is fine
  payloadFormatVersion: "2.0",
});

// Keep only the /auth routes
new aws.apigatewayv2.Route("authANYRoute", {
  apiId: api.id,
  routeKey: "ANY /auth",
  target: pulumi.interpolate`integrations/${authIntegration.id}`,
});
new aws.apigatewayv2.Route("authANYProxyRoute", {
  apiId: api.id,
  routeKey: "ANY /auth/{proxy+}",
  target: pulumi.interpolate`integrations/${authIntegration.id}`,
});

// Use autoDeploy, no explicit Deployment resource
const httpLogs = new aws.cloudwatch.LogGroup("httpApiAccessLogs", {
  name: "/aws/http-api/auth-access",
  retentionInDays: 14,
});

// Allow API Gateway to write to this log group (optional but recommended)
const apiGwLogsPolicy = new aws.cloudwatch.LogResourcePolicy("apiGwAccessLogsPolicy", {
  policyName: "ApiGatewayAccessLogs",
  policyDocument: httpLogs.arn.apply(lgArn => JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "ApiGwToCwLogs",
      Effect: "Allow",
      Principal: { Service: "apigateway.amazonaws.com" },
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `${lgArn}:*`,
    }],
  })),
});

const stage = new aws.apigatewayv2.Stage("apiStage", {
  apiId: api.id,
  name: "$default",
  autoDeploy: true,
  accessLogSettings: {
    destinationArn: httpLogs.arn,
    format: JSON.stringify({
      requestId: "$context.requestId",
      requestTime: "$context.requestTime",
      httpMethod: "$context.httpMethod",
      path: "$context.path",
      routeKey: "$context.routeKey",
      status: "$context.status",
      protocol: "$context.protocol",
      responseLength: "$context.responseLength",
      error: "$context.error.message"
    }),
  },
}, { dependsOn: [apiGwLogsPolicy] });

// Custom domain (must be in the same region as API; cert must be in that region)
const apiDomain = new aws.apigatewayv2.DomainName("apiDomain", {
  domainName: domainName,
  domainNameConfiguration: {
    certificateArn: certificateArn,
    endpointType: "REGIONAL",
    securityPolicy: "TLS_1_2",
  },
});

// Map to the $default stage; pass the stage name
new aws.apigatewayv2.ApiMapping("apiMapping", {
  apiId: api.id,
  domainName: apiDomain.domainName,
  stage: stage.name,
});

// Outputs helpful for testing
export const apiUrl = api.apiEndpoint; // test this first: https://[apiId].execute-api.[region].amazonaws.com/auth/login
export const customApiUrl = `https://${domainName}/auth/login`;
export const dnsTargetDomainName = apiDomain.domainNameConfiguration.apply(dnc => dnc.targetDomainName);
export const dnsTargetHostedZoneId = apiDomain.domainNameConfiguration.apply(dnc => dnc.hostedZoneId);

