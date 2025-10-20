import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";

const accountId = aws.getCallerIdentity().then(identity => identity.accountId);
const domainName = "api.tommybradbury.co.uk";
const certificateArn = "arn:aws:acm:eu-west-2:140293477718:certificate/dc46af13-b4c4-4759-bf96-5b5b04444b4f";
const brefPhpLayerArn = "arn:aws:lambda:us-east-1:534081306603:layer:php-84-fpm:34";

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

/**
 * create bref php lambda function
 * @param name 
 * @param zipFileName 
 * @param description 
 * @returns 
 */
function createBrefFunction(name: string, zipFileName: string, description: string) {
    const lambdaFunction = new aws.lambda.Function(name, {
        name: name,
        code: new pulumi.asset.FileArchive(path.join(process.cwd(), "lambda_code", zipFileName)),
        runtime: "provided.al2",
        architectures: ["x86_64"],
        handler: "index.php",
        role: role.arn,
        memorySize: 256,
        timeout: 10,
        layers: [brefPhpLayerArn],
        tags: { Name: name, Description: description },
        publish: true
    });

    const devAlias = new aws.lambda.Alias(`${name}DevAlias`, {
        functionName: lambdaFunction.name,
        functionVersion: lambdaFunction.version,
        name: "dev",
    }, { dependsOn: [lambdaFunction] });

    const permission = new aws.lambda.Permission(`${name}ApiGatewayPermission`, {
        action: "lambda:InvokeFunction",
        function: devAlias.arn,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`arn:aws:execute-api:${aws.config.region}:${accountId}:${api.id}/*/*`,
    }, { dependsOn: [devAlias, api] });

    return { function: lambdaFunction, version: lambdaFunction.version, alias: devAlias, permission: permission };
}

const authService = createBrefFunction(
    "AuthServiceLambda",
    "lambda-auth.zip",
    "Handles /auth/ route"
);

const authIntegration = new aws.apigatewayv2.Integration("authIntegration", {
    apiId: api.id,
    integrationType: "AWS_PROXY",
    integrationUri: authService.alias.invokeArn,
    payloadFormatVersion: "2.0",
});


const authANYRoute = new aws.apigatewayv2.Route("authPOSTRoute", {
    apiId: api.id,
    routeKey: "ANY /auth",
    target: pulumi.interpolate`integrations/${authIntegration.id}`,
});

const authANYProxyRoute = new aws.apigatewayv2.Route("authANYProxyRoute", {
    apiId: api.id,
    routeKey: "ANY /auth/{proxy+}",
    target: pulumi.interpolate`integrations/${authIntegration.id}`,
});

// --- API Gateway Deployment and Stage ---
const deployment = new aws.apigatewayv2.Deployment("apiDeployment", {
    apiId: api.id,
}, { dependsOn: [authANYRoute, authANYProxyRoute] });

const httpLogs = new aws.cloudwatch.LogGroup("httpApiAccessLogs", { retentionInDays: 14 });

const stage = new aws.apigatewayv2.Stage("apiStage", {
  apiId: api.id,
  name: "$default",
  autoDeploy: true,
  accessLogSettings: {
    destinationArn: httpLogs.arn,
    format: JSON.stringify({
      requestId: "$context.requestId",
      time: "$context.time",
      httpMethod: "$context.httpMethod",
      path: "$context.path",
      routeKey: "$context.routeKey",
      status: "$context.status",
      integrationStatus: "$context.integrationStatus",
      errorMessage: "$context.error.message",
      integrationErrorMessage: "$context.integrationErrorMessage",
      responseLength: "$context.responseLength",
      ip: "$context.identity.sourceIp",
      userAgent: "$context.identity.userAgent",
    }),
  },
});

const apiDomain = new aws.apigatewayv2.DomainName("apiDomain", {
    domainName: domainName,
    domainNameConfiguration: {
        certificateArn: certificateArn,
        endpointType: "REGIONAL",
        securityPolicy: "TLS_1_2",
    },
});

const apiMapping = new aws.apigatewayv2.ApiMapping("apiMapping", {
    apiId: api.id,
    domainName: apiDomain.domainName,
    stage: stage.id,
});

// --- Outputs ---
export const apiUrl = api.apiEndpoint;
export const customApiUrl = `https://${domainName}/auth`;
export const lambdaVersion = authService.version;
export const dnsTargetDomainName = apiDomain.domainNameConfiguration.apply(dnc => dnc.targetDomainName);
export const dnsTargetHostedZoneId = apiDomain.domainNameConfiguration.apply(dnc => dnc.hostedZoneId);

