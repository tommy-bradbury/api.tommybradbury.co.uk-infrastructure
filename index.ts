import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import * as fs from "fs";

const accountId = aws.getCallerIdentity().then(identity => identity.accountId);
const certificateArn = "arn:aws:acm:eu-west-2:140293477718:certificate/dc46af13-b4c4-4759-bf96-5b5b04444b4f";
const domainName = "api.tommybradbury.co.uk";
const brefPhpLayerArn = "arn:aws:lambda:eu-west-2:534081306603:layer:php-84:34"; 

// Lambda iam role with cloudwatch permission
const role = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

new aws.iam.RolePolicyAttachment("lambdaPolicyAttachment", {
    role: role,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

// --- HELPER FUNCTION FOR CREATING AND DEPLOYING LAMBDAS ---
// This function encapsulates the repeating logic for creating a Function, Version, and Dev Alias.
/**
 * Creating a Function, Version, and Dev Alias for a given lambda.
 * 
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
        handler: "bref/entrypoint.php",
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

    // Grant API Gateway permission to invoke this Lambda function
    const permission = new aws.lambda.Permission(`${name}ApiGatewayPermission`, {
        action: "lambda:InvokeFunction",
        function: lambdaFunction,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`arn:aws:execute-api:${aws.config.region}:${accountId}:*/*/*/*`,
    }, { dependsOn: [lambdaFunction] });

    return { function: lambdaFunction, version: lambdaFunction.version, alias: devAlias, permission: permission };
}


const authService = createBrefFunction(
    "AuthServiceLambda",
    "lambda-auth.zip",
    "Handles /auth/ route"
);

// const otherService = createBrefFunction(
//     "otherServiceLambda",
//     "other.zip", // Requires 'lambda_code/status.zip' artifact
//     "Handles /other/ route"
// );

// Create a single HTTP API Gateway
const api = new aws.apigatewayv2.Api("httpApi", {
    protocolType: "HTTP",
    name: "api.tommybradbury.co.uk",
});

// integration for auth group
const authIntegration = new aws.apigatewayv2.Integration("authIntegration", {
    apiId: api.id,
    integrationType: "AWS_PROXY",
    integrationUri: authService.alias.arn, 
    integrationMethod: "POST",
    payloadFormatVersion: "2.0",
});

// const otherIntegration = new aws.apigatewayv2.Integration("statusIntegration", {
//     apiId: api.id,
//     integrationType: "AWS_PROXY",
//     integrationUri: otherService.alias.arn, 
//     integrationMethod: "POST",
//     payloadFormatVersion: "2.0",
// });


// define the Routes
const authGETRoute = new aws.apigatewayv2.Route("authGETRoute", {
    apiId: api.id,
    routeKey: "GET /auth",
    target: pulumi.interpolate`integrations/${authIntegration.id}`,
});
const authPOSTRoute = new aws.apigatewayv2.Route("authPOSTRoute", {
    apiId: api.id,
    routeKey: "GET /auth",
    target: pulumi.interpolate`integrations/${authIntegration.id}`,
});


// const otherRoute = new aws.apigatewayv2.Route("otherRoute", {
//     apiId: api.id,
//     routeKey: "GET /other",
//     target: pulumi.interpolate`integrations/${otherIntegration.id}`,
// });


// deploy
const deployment = new aws.apigatewayv2.Deployment("apiDeployment", {apiId: api.id}, {dependsOn: [authGETRoute, authPOSTRoute]});

// create a stage, which is necessary to invoke the API
const stage = new aws.apigatewayv2.Stage("apiStage", {
    apiId: api.id,
    name: "$default",
    deploymentId: deployment.id,
    autoDeploy: true,
    defaultRouteSettings: {
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
    },
});

// register domain name with API Gateway (using ACM certificate)
const APITommyBradbury = new aws.apigatewayv2.DomainName("api.tommybradbury.co.uk", {
    domainName: domainName,
    domainNameConfiguration: {
        certificateArn: certificateArn,
        endpointType: "REGIONAL", 
        securityPolicy: "TLS_1_2",
    },
    tags: {
        Name: "api.tommybradbury.co.uk",
    },
});

// map the API Gateway Stage to the Custom Domain
const apiMapping = new aws.apigatewayv2.ApiMapping("apiMapping", {
    apiId: api.id,
    domainName: APITommyBradbury.domainName,
    stage: stage.id,
    // apiMappingKey empty -> mapped to root (/)
});

export const apiUrl = api.apiEndpoint; 
export const authApiUrl = pulumi.interpolate`https://${APITommyBradbury.domainName}/auth`;
export const dnsTargetDomainName = APITommyBradbury.domainNameConfiguration.targetDomainName;
export const dnsTargetHostedZoneId = APITommyBradbury.domainNameConfiguration.hostedZoneId;
export const memeDevLambdaVersion = authService.version;
