import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";

// --- Configuration ---
const accountId = aws.getCallerIdentity().then(identity => identity.accountId);
const domainName = "api.tommybradbury.co.uk";
const brefPhpLayerArn = "arn:aws:lambda:eu-west-2:534081306603:layer:php-84:34";

// --- IAM Role for Lambda ---
const role = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

new aws.iam.RolePolicyAttachment("lambdaPolicyAttachment", {
    role: role,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

// --- API Gateway ---
// Create a new API Gateway, as the previous one was deleted.
const api = new aws.apigatewayv2.Api("httpApi", {
    protocolType: "HTTP",
    name: "api.tommybradbury.co.uk-auth-service", // A specific name for this new API
});

// --- Helper Function for Lambda Creation ---
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

    // Grant API Gateway permission to invoke the Lambda alias
    const permission = new aws.lambda.Permission(`${name}ApiGatewayPermission`, {
        action: "lambda:InvokeFunction",
        // FIX (TS2322): Pass the ARN of the alias, not the alias object itself.
        function: devAlias.arn,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`arn:aws:execute-api:${aws.config.region}:${accountId}:${api.id}/*/*`,
    }, { dependsOn: [devAlias, api] });

    return { function: lambdaFunction, version: lambdaFunction.version, alias: devAlias, permission: permission };
}

// --- Lambda Function ---
const authService = createBrefFunction(
    "AuthServiceLambda",
    "lambda-auth.zip",
    "Handles /auth/ route"
);

// --- API Gateway Integration ---
const authIntegration = new aws.apigatewayv2.Integration("authIntegration", {
    apiId: api.id,
    integrationType: "AWS_PROXY",
    integrationUri: authService.alias.invokeArn,
    payloadFormatVersion: "2.0",
});

// --- API Gateway Routes ---
const authGETRoute = new aws.apigatewayv2.Route("authGETRoute", {
    apiId: api.id,
    routeKey: "GET /auth",
    target: pulumi.interpolate`integrations/${authIntegration.id}`,
});

const authPOSTRoute = new aws.apigatewayv2.Route("authPOSTRoute", {
    apiId: api.id,
    routeKey: "POST /auth",
    target: pulumi.interpolate`integrations/${authIntegration.id}`,
});

// --- API Gateway Deployment and Stage ---
const deployment = new aws.apigatewayv2.Deployment("apiDeployment", {
    apiId: api.id,
}, { dependsOn: [authGETRoute, authPOSTRoute] });

const stage = new aws.apigatewayv2.Stage("apiStage", {
    apiId: api.id,
    name: "$default",
    deploymentId: deployment.id,
    autoDeploy: true,
});

// --- Custom Domain ---
// FIX (TS2551): The function is getDomainName. The error is unusual and may be
// related to your local @pulumi/aws package version, but this is the correct usage.
const existingDomain = aws.apigatewayv2.getDomainName({
    domainName: domainName,
});

// --- API Mapping ---
const apiMapping = new aws.apigatewayv2.ApiMapping("apiMapping", {
    apiId: api.id,
    // FIX: Use the 'domainName' property from the lookup result.
    domainName: existingDomain.then(d => d.domainName),
    stage: stage.id,
});

// --- Outputs ---
export const apiUrl = api.apiEndpoint;
export const customApiUrl = `https://${domainName}/auth`;
export const lambdaVersion = authService.version;
// FIX (TS7006): Explicitly type 'd' to resolve implicit 'any' type errors.
export const dnsTargetDomainName = existingDomain.then((d: aws.apigatewayv2.GetDomainNameResult) => d.domainNameConfiguration?.targetDomainName);
export const dnsTargetHostedZoneId = existingDomain.then((d: aws.apigatewayv2.GetDomainNameResult) => d.domainNameConfiguration?.hostedZoneId);

