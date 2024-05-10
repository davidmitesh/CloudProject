"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RekognitionLambdaS3TriggerStack = void 0;
const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const s3 = require("aws-cdk-lib/aws-s3");
const iam = require("aws-cdk-lib/aws-iam");
const aws_dynamodb_1 = require("aws-cdk-lib/aws-dynamodb");
const path = require("path");
const s3n = require("aws-cdk-lib/aws-s3-notifications");
const apigw = require("aws-cdk-lib/aws-apigateway");
const cognito = require("aws-cdk-lib/aws-cognito");
// import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
const sqs = require("aws-cdk-lib/aws-sqs");
const event_sources = require("aws-cdk-lib/aws-lambda-event-sources");
const snsSubscriptions = require("aws-cdk-lib/aws-sns-subscriptions");
const sns = require("aws-cdk-lib/aws-sns");
class RekognitionLambdaS3TriggerStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create S3 Bucket
        const bucket = new s3.Bucket(this, 'Bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });
        bucket.addCorsRule({
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
            allowedOrigins: ["*"],
            allowedHeaders: ["*"],
            maxAge: 3000
        });
        const imageBucketArn = bucket.bucketArn;
        // const websiteBucketName = "cdk-rekn-publicbucket"
        // =====================================================================================
        // Construct to create our Amazon S3 Bucket to host our website
        // =====================================================================================
        // const webBucket = new s3.Bucket(this, websiteBucketName, {
        //   websiteIndexDocument: 'index.html',
        //   removalPolicy: cdk.RemovalPolicy.DESTROY,
        //   publicReadAccess: true,
        //   autoDeleteObjects: true
        // });
        // webBucket.addToResourcePolicy(new iam.PolicyStatement({
        //   actions: ['s3:GetObject'],
        //   resources: [webBucket.arnForObjects('*')],
        //   principals: [new iam.AnyPrincipal()],
        //   conditions: {
        //     'IpAddress': {
        //       'aws:SourceIp': [
        //         '103.27.9.104/32' // Please change it to your IP address or from your allowed list
        //         ]
        //     }
        //   }
        // }))
        // new cdk.CfnOutput(this, 'bucketURL', { value: webBucket.bucketWebsiteDomainName });
        // =====================================================================================
        // Deploy site contents to S3 Bucket
        // =====================================================================================
        // new s3deploy.BucketDeployment(this, 'DeployWebsite', {
        //     sources: [ s3deploy.Source.asset('./public') ],
        //     destinationBucket: webBucket
        // });
        // create DynamoDB table to hold Rekognition results
        const table = new aws_dynamodb_1.Table(this, 'Classifications', {
            partitionKey: {
                name: 'image_name',
                type: aws_dynamodb_1.AttributeType.STRING
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY // removes table on cdk destroy
        });
        // create Lambda function
        const lambdaFunction = new lambda.Function(this, 'RekFunction', {
            handler: 'rekfunction.handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                'BUCKET_NAME': bucket.bucketName,
                'TABLE_NAME': table.tableName
            }
        });
        // add Rekognition permissions for Lambda function
        const statement = new iam.PolicyStatement();
        statement.addActions("rekognition:DetectLabels");
        statement.addResources("*");
        lambdaFunction.addToRolePolicy(statement);
        // // create trigger for Lambda function with image type suffixes
        // bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(lambdaFunction),{suffix: '.jpg'});
        // bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(lambdaFunction),{suffix: '.jpeg'});
        // bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(lambdaFunction),{suffix: '.png'});
        // grant permissions for lambda to read/write to DynamoDB table and bucket
        table.grantReadWriteData(lambdaFunction);
        bucket.grantReadWrite(lambdaFunction);
        new cdk.CfnOutput(this, "UploadImageToS3", {
            value: `aws s3 cp <local-path-to-image> s3://${bucket.bucketName}/`,
            description: "Upload an image to S3 (using AWS CLI) to trigger Rekognition",
        });
        new cdk.CfnOutput(this, "DynamoDBTable", {
            value: table.tableName,
            description: "This is where the image Rekognition results will be stored.",
        });
        new cdk.CfnOutput(this, "LambdaFunction", {
            value: lambdaFunction.functionName,
        });
        new cdk.CfnOutput(this, "LambdaFunctionLogs", {
            value: lambdaFunction.logGroup.logGroupName,
        });
        //create service lambda function 
        const serviceFn = new lambda.Function(this, 'serviceFunction', {
            code: lambda.Code.fromAsset('servicelambda'),
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.handler',
            environment: {
                "TABLE": table.tableName,
                "BUCKET": bucket.bucketName,
            },
        });
        bucket.grantWrite(serviceFn);
        table.grantReadWriteData(serviceFn);
        // =====================================================================================
        // This construct builds a new Amazon API Gateway with AWS Lambda Integration
        // =====================================================================================
        const api = new apigw.LambdaRestApi(this, 'imageAPI', {
            defaultCorsPreflightOptions: {
                allowOrigins: apigw.Cors.ALL_ORIGINS,
                allowMethods: apigw.Cors.ALL_METHODS
            },
            handler: serviceFn,
            proxy: false,
        });
        const lambdaIntegration = new apigw.LambdaIntegration(serviceFn, {
            proxy: false,
            requestParameters: {
                'integration.request.querystring.action': 'method.request.querystring.action',
                'integration.request.querystring.key': 'method.request.querystring.key'
            },
            requestTemplates: {
                'application/json': JSON.stringify({ action: "$util.escapeJavaScript($input.params('action'))", key: "$util.escapeJavaScript($input.params('key'))" })
            },
            passthroughBehavior: apigw.PassthroughBehavior.WHEN_NO_TEMPLATES,
            integrationResponses: [
                {
                    statusCode: "200",
                    responseParameters: {
                        // We can map response parameters
                        // - Destination parameters (the key) are the response parameters (used in mappings)
                        // - Source parameters (the value) are the integration response parameters or expressions
                        'method.response.header.Access-Control-Allow-Origin': "'*'"
                    }
                },
                {
                    // For errors, we check if the error message is not empty, get the error data
                    selectionPattern: "(\n|.)+",
                    statusCode: "500",
                    responseParameters: {
                        'method.response.header.Access-Control-Allow-Origin': "'*'"
                    }
                }
            ],
        });
        // =====================================================================================
        // Cognito User Pool Authentication
        // =====================================================================================
        const userPool = new cognito.UserPool(this, "UserPool", {
            selfSignUpEnabled: true,
            autoVerify: { email: true },
            signInAliases: { username: true, email: true }, // Set email as an alias
        });
        const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
            userPool,
            generateSecret: false, // Don't need to generate secret for web app running on browsers
        });
        const identityPool = new cognito.CfnIdentityPool(this, "ImageRekognitionIdentityPool", {
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [
                {
                    clientId: userPoolClient.userPoolClientId,
                    providerName: userPool.userPoolProviderName,
                },
            ],
        });
        const auth = new apigw.CfnAuthorizer(this, 'APIGatewayAuthorizer', {
            name: 'customer-authorizer',
            identitySource: 'method.request.header.Authorization',
            providerArns: [userPool.userPoolArn],
            restApiId: api.restApiId,
            type: apigw.AuthorizationType.COGNITO,
        });
        const authenticatedRole = new iam.Role(this, "ImageRekognitionAuthenticatedRole", {
            assumedBy: new iam.FederatedPrincipal("cognito-identity.amazonaws.com", {
                StringEquals: {
                    "cognito-identity.amazonaws.com:aud": identityPool.ref,
                },
                "ForAnyValue:StringLike": {
                    "cognito-identity.amazonaws.com:amr": "authenticated",
                },
            }, "sts:AssumeRoleWithWebIdentity"),
        });
        // IAM policy granting users permission to upload, download and delete their own pictures
        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "s3:GetObject",
                "s3:PutObject"
            ],
            effect: iam.Effect.ALLOW,
            resources: [
                imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
                imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}",
            ],
        }));
        // IAM policy granting users permission to list their pictures
        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            actions: ["s3:ListBucket"],
            effect: iam.Effect.ALLOW,
            resources: [
                imageBucketArn,
            ],
            conditions: { "StringLike": { "s3:prefix": ["private/${cognito-identity.amazonaws.com:sub}/*"] } }
        }));
        new cognito.CfnIdentityPoolRoleAttachment(this, "IdentityPoolRoleAttachment", {
            identityPoolId: identityPool.ref,
            roles: { authenticated: authenticatedRole.roleArn },
        });
        // Export values of Cognito
        new cdk.CfnOutput(this, "UserPoolId", {
            value: userPool.userPoolId,
        });
        new cdk.CfnOutput(this, "AppClientId", {
            value: userPoolClient.userPoolClientId,
        });
        new cdk.CfnOutput(this, "IdentityPoolId", {
            value: identityPool.ref,
        });
        // =====================================================================================
        // API Gateway
        // =====================================================================================
        const imageAPI = api.root.addResource('images');
        // GET /images
        imageAPI.addMethod('GET', lambdaIntegration, {
            authorizationType: apigw.AuthorizationType.COGNITO,
            authorizer: { authorizerId: auth.ref },
            requestParameters: {
                'method.request.querystring.action': true,
                'method.request.querystring.key': true
            },
            methodResponses: [
                {
                    statusCode: "200",
                    responseParameters: {
                        'method.response.header.Access-Control-Allow-Origin': true,
                    },
                },
                {
                    statusCode: "500",
                    responseParameters: {
                        'method.response.header.Access-Control-Allow-Origin': true,
                    },
                }
            ]
        });
        // DELETE /images
        imageAPI.addMethod('DELETE', lambdaIntegration, {
            authorizationType: apigw.AuthorizationType.COGNITO,
            authorizer: { authorizerId: auth.ref },
            requestParameters: {
                'method.request.querystring.action': true,
                'method.request.querystring.key': true
            },
            methodResponses: [
                {
                    statusCode: "200",
                    responseParameters: {
                        'method.response.header.Access-Control-Allow-Origin': true,
                    },
                },
                {
                    statusCode: "500",
                    responseParameters: {
                        'method.response.header.Access-Control-Allow-Origin': true,
                    },
                }
            ]
        });
        // Building SQS queue and DeadLetter Queue
        // =====================================================================================
        const deadLetterQueue = new sqs.Queue(this, 'ImgUploadDeadLetterQueue', {
            queueName: 'ImgUploadDeadLetterQueue',
            retentionPeriod: cdk.Duration.days(7)
        });
        const uploadQueue = new sqs.Queue(this, 'ImgUploadQueue', {
            queueName: 'ImgUploadQueue',
            visibilityTimeout: cdk.Duration.seconds(30),
            deadLetterQueue: {
                maxReceiveCount: 1,
                queue: deadLetterQueue
            }
        });
        // Create a SNS Topic.
        const uploadEventTopic = new sns.Topic(this, 'ImgUploadTopic', {
            topicName: 'ImgUploadTopic'
        });
        // Bind the SQS Queue to the SNS Topic.
        const sqsSubscription = new snsSubscriptions.SqsSubscription(uploadQueue, {
            rawMessageDelivery: true
        });
        uploadEventTopic.addSubscription(sqsSubscription);
        // =====================================================================================
        // Building S3 Bucket Create Notification to SQS
        // =====================================================================================
        // bucket.addObjectCreatedNotification(new s3n.SqsDestination(queue), { prefix: 'private/' })
        // Binds the S3 bucket to the SNS Topic.
        bucket.addEventNotification(
        // Modify the `s3.EventType.*` to handle other object operations.
        s3.EventType.OBJECT_CREATED_PUT, new s3n.SnsDestination(uploadEventTopic), {
            // The trigger will only fire on files with the .csv extension.
            suffix: '.png'
        });
        // =====================================================================================
        // Lambda(Rekognition) to consume messages from SQS
        // =====================================================================================
        // lambdaFunction.addEventSource(new event_sources.SqsEventSource(queue));
        // Bind the Lambda to the SQS Queue.
        const invokeEventSource = new event_sources.SqsEventSource(uploadQueue);
        lambdaFunction.addEventSource(invokeEventSource);
    }
}
exports.RekognitionLambdaS3TriggerStack = RekognitionLambdaS3TriggerStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVrb2duaXRpb24tbGFtYmRhLXMzLXRyaWdnZXItc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZWtvZ25pdGlvbi1sYW1iZGEtczMtdHJpZ2dlci1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsaURBQWlEO0FBQ2pELHlDQUF5QztBQUN6QywyQ0FBMkM7QUFDM0MsMkRBQWdFO0FBRWhFLDZCQUE2QjtBQUM3Qix3REFBd0Q7QUFDeEQsb0RBQW9EO0FBQ3BELG1EQUFrRDtBQUNsRCw2REFBNkQ7QUFDN0QsMkNBQTJDO0FBQzNDLHNFQUFzRTtBQUN0RSxzRUFBc0U7QUFDdEUsMkNBQTJDO0FBRTNDLE1BQWEsK0JBQWdDLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDNUQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixtQkFBbUI7UUFDbkIsTUFBTSxNQUFNLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDM0MsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxpQkFBaUIsRUFBRSxJQUFJO1NBQ3hCLENBQUMsQ0FBQztRQUVILE1BQU0sQ0FBQyxXQUFXLENBQUM7WUFDakIsY0FBYyxFQUFFLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUM7WUFDeEQsY0FBYyxFQUFFLENBQUMsR0FBRyxDQUFDO1lBQ3JCLGNBQWMsRUFBRSxDQUFDLEdBQUcsQ0FBQztZQUNyQixNQUFNLEVBQUUsSUFBSTtTQUNiLENBQUMsQ0FBQztRQUVILE1BQU0sY0FBYyxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUM7UUFDeEMsb0RBQW9EO1FBRXBELHdGQUF3RjtRQUN4RiwrREFBK0Q7UUFDL0Qsd0ZBQXdGO1FBQ3hGLDZEQUE2RDtRQUM3RCx3Q0FBd0M7UUFDeEMsOENBQThDO1FBQzlDLDRCQUE0QjtRQUM1Qiw0QkFBNEI7UUFDNUIsTUFBTTtRQUVOLDBEQUEwRDtRQUMxRCwrQkFBK0I7UUFDL0IsK0NBQStDO1FBQy9DLDBDQUEwQztRQUMxQyxrQkFBa0I7UUFDbEIscUJBQXFCO1FBQ3JCLDBCQUEwQjtRQUMxQiw2RkFBNkY7UUFDN0YsWUFBWTtRQUNaLFFBQVE7UUFDUixNQUFNO1FBRU4sTUFBTTtRQUNOLHNGQUFzRjtRQUV0Rix3RkFBd0Y7UUFDeEYsb0NBQW9DO1FBQ3BDLHdGQUF3RjtRQUN4Rix5REFBeUQ7UUFDekQsc0RBQXNEO1FBQ3RELG1DQUFtQztRQUNuQyxNQUFNO1FBRU4sb0RBQW9EO1FBQ3BELE1BQU0sS0FBSyxHQUFHLElBQUksb0JBQUssQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDL0MsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxZQUFZO2dCQUNsQixJQUFJLEVBQUUsNEJBQWEsQ0FBQyxNQUFNO2FBQzNCO1lBQ0QsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLCtCQUErQjtTQUN6RSxDQUFDLENBQUM7UUFLSCx5QkFBeUI7UUFDekIsTUFBTSxjQUFjLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDOUQsT0FBTyxFQUFFLHFCQUFxQjtZQUM5QixPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxXQUFXLENBQUMsQ0FBQztZQUM5RCxXQUFXLEVBQUU7Z0JBQ1gsYUFBYSxFQUFFLE1BQU0sQ0FBQyxVQUFVO2dCQUNoQyxZQUFZLEVBQUUsS0FBSyxDQUFDLFNBQVM7YUFDOUI7U0FDRixDQUFDLENBQUM7UUFFSCxrREFBa0Q7UUFDbEQsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLENBQUMsZUFBZSxFQUFFLENBQUM7UUFDNUMsU0FBUyxDQUFDLFVBQVUsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO1FBQ2pELFNBQVMsQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDNUIsY0FBYyxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUUxQyxpRUFBaUU7UUFDakUsd0hBQXdIO1FBQ3hILHlIQUF5SDtRQUN6SCx3SEFBd0g7UUFFeEgsMEVBQTBFO1FBQzFFLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUN6QyxNQUFNLENBQUMsY0FBYyxDQUFDLGNBQWMsQ0FBQyxDQUFDO1FBQ3hDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDdkMsS0FBSyxFQUFFLHdDQUF3QyxNQUFNLENBQUMsVUFBVSxHQUFHO1lBQ25FLFdBQVcsRUFBRSw4REFBOEQ7U0FDNUUsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUU7WUFDdkMsS0FBSyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQ3RCLFdBQVcsRUFBRSw2REFBNkQ7U0FDM0UsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUN4QyxLQUFLLEVBQUUsY0FBYyxDQUFDLFlBQVk7U0FDbkMsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUM1QyxLQUFLLEVBQUUsY0FBYyxDQUFDLFFBQVEsQ0FBQyxZQUFZO1NBQzVDLENBQUMsQ0FBQztRQUVILGlDQUFpQztRQUVqQyxNQUFNLFNBQVMsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQzdELElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUM7WUFDNUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsVUFBVTtZQUNsQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixXQUFXLEVBQUU7Z0JBQ1gsT0FBTyxFQUFFLEtBQUssQ0FBQyxTQUFTO2dCQUN4QixRQUFRLEVBQUUsTUFBTSxDQUFDLFVBQVU7YUFDNUI7U0FDRixDQUFDLENBQUM7UUFFSCxNQUFNLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQzdCLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUdwQyx3RkFBd0Y7UUFDeEYsNkVBQTZFO1FBQzdFLHdGQUF3RjtRQUV4RixNQUFNLEdBQUcsR0FBRyxJQUFJLEtBQUssQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtZQUNwRCwyQkFBMkIsRUFBRTtnQkFDM0IsWUFBWSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVztnQkFDcEMsWUFBWSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVzthQUNyQztZQUNELE9BQU8sRUFBRSxTQUFTO1lBQ2xCLEtBQUssRUFBRSxLQUFLO1NBQ2IsQ0FBQyxDQUFDO1FBRUgsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxTQUFTLEVBQUU7WUFDL0QsS0FBSyxFQUFFLEtBQUs7WUFDWixpQkFBaUIsRUFBRTtnQkFDakIsd0NBQXdDLEVBQUUsbUNBQW1DO2dCQUM3RSxxQ0FBcUMsRUFBRSxnQ0FBZ0M7YUFDeEU7WUFDRCxnQkFBZ0IsRUFBRTtnQkFDaEIsa0JBQWtCLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLE1BQU0sRUFBRSxpREFBaUQsRUFBRSxHQUFHLEVBQUUsOENBQThDLEVBQUUsQ0FBQzthQUN2SjtZQUNELG1CQUFtQixFQUFFLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxpQkFBaUI7WUFDaEUsb0JBQW9CLEVBQUU7Z0JBQ3BCO29CQUNFLFVBQVUsRUFBRSxLQUFLO29CQUNqQixrQkFBa0IsRUFBRTt3QkFDbEIsaUNBQWlDO3dCQUNqQyxvRkFBb0Y7d0JBQ3BGLHlGQUF5Rjt3QkFDekYsb0RBQW9ELEVBQUUsS0FBSztxQkFDNUQ7aUJBQ0Y7Z0JBQ0Q7b0JBQ0UsNkVBQTZFO29CQUM3RSxnQkFBZ0IsRUFBRSxTQUFTO29CQUMzQixVQUFVLEVBQUUsS0FBSztvQkFDakIsa0JBQWtCLEVBQUU7d0JBQ2xCLG9EQUFvRCxFQUFFLEtBQUs7cUJBQzVEO2lCQUNGO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFHSCx3RkFBd0Y7UUFDeEYsbUNBQW1DO1FBQ25DLHdGQUF3RjtRQUN4RixNQUFNLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtZQUN0RCxpQkFBaUIsRUFBRSxJQUFJO1lBQ3ZCLFVBQVUsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUU7WUFDM0IsYUFBYSxFQUFFLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEVBQUUsd0JBQXdCO1NBQ3pFLENBQUMsQ0FBQztRQUVILE1BQU0sY0FBYyxHQUFHLElBQUksT0FBTyxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDeEUsUUFBUTtZQUNSLGNBQWMsRUFBRSxLQUFLLEVBQUUsZ0VBQWdFO1NBQ3hGLENBQUMsQ0FBQztRQUVILE1BQU0sWUFBWSxHQUFHLElBQUksT0FBTyxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsOEJBQThCLEVBQUU7WUFDckYsOEJBQThCLEVBQUUsS0FBSztZQUNyQyx3QkFBd0IsRUFBRTtnQkFDeEI7b0JBQ0EsUUFBUSxFQUFFLGNBQWMsQ0FBQyxnQkFBZ0I7b0JBQ3pDLFlBQVksRUFBRSxRQUFRLENBQUMsb0JBQW9CO2lCQUMxQzthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxJQUFJLEdBQUcsSUFBSSxLQUFLLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUNqRSxJQUFJLEVBQUUscUJBQXFCO1lBQzNCLGNBQWMsRUFBRSxxQ0FBcUM7WUFDckQsWUFBWSxFQUFFLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQztZQUNwQyxTQUFTLEVBQUUsR0FBRyxDQUFDLFNBQVM7WUFDeEIsSUFBSSxFQUFFLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPO1NBQ3RDLENBQUMsQ0FBQztRQUVILE1BQU0saUJBQWlCLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxtQ0FBbUMsRUFBRTtZQUNoRixTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsa0JBQWtCLENBQ25DLGdDQUFnQyxFQUM5QjtnQkFDQSxZQUFZLEVBQUU7b0JBQ1Ysb0NBQW9DLEVBQUUsWUFBWSxDQUFDLEdBQUc7aUJBQ3pEO2dCQUNELHdCQUF3QixFQUFFO29CQUN4QixvQ0FBb0MsRUFBRSxlQUFlO2lCQUN0RDthQUNGLEVBQ0QsK0JBQStCLENBQ2hDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgseUZBQXlGO1FBQ3pGLGlCQUFpQixDQUFDLFdBQVcsQ0FDM0IsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3RCLE9BQU8sRUFBRTtnQkFDUCxjQUFjO2dCQUNkLGNBQWM7YUFDZjtZQUNELE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsU0FBUyxFQUFFO2dCQUNULGNBQWMsR0FBRyxrREFBa0Q7Z0JBQ25FLGNBQWMsR0FBRyxnREFBZ0Q7YUFDbEU7U0FDRixDQUFDLENBQ0gsQ0FBQztRQUVGLDhEQUE4RDtRQUM5RCxpQkFBaUIsQ0FBQyxXQUFXLENBQzNCLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixPQUFPLEVBQUUsQ0FBQyxlQUFlLENBQUM7WUFDMUIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixTQUFTLEVBQUU7Z0JBQ1QsY0FBYzthQUNmO1lBQ0QsVUFBVSxFQUFFLEVBQUMsWUFBWSxFQUFFLEVBQUMsV0FBVyxFQUFFLENBQUMsaURBQWlELENBQUMsRUFBQyxFQUFDO1NBQy9GLENBQUMsQ0FDSCxDQUFDO1FBRUYsSUFBSSxPQUFPLENBQUMsNkJBQTZCLENBQUMsSUFBSSxFQUFFLDRCQUE0QixFQUFFO1lBQzVFLGNBQWMsRUFBRSxZQUFZLENBQUMsR0FBRztZQUNoQyxLQUFLLEVBQUUsRUFBRSxhQUFhLEVBQUUsaUJBQWlCLENBQUMsT0FBTyxFQUFFO1NBQ3BELENBQUMsQ0FBQztRQUVILDJCQUEyQjtRQUMzQixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsUUFBUSxDQUFDLFVBQVU7U0FDM0IsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDckMsS0FBSyxFQUFFLGNBQWMsQ0FBQyxnQkFBZ0I7U0FDdkMsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUN4QyxLQUFLLEVBQUUsWUFBWSxDQUFDLEdBQUc7U0FDeEIsQ0FBQyxDQUFDO1FBTUgsd0ZBQXdGO1FBQ3hGLGNBQWM7UUFDZCx3RkFBd0Y7UUFDeEYsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLENBQUM7UUFFaEQsY0FBYztRQUNkLFFBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxFQUFFLGlCQUFpQixFQUFFO1lBQzNDLGlCQUFpQixFQUFFLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPO1lBQ2xELFVBQVUsRUFBRSxFQUFFLFlBQVksRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFO1lBQ3RDLGlCQUFpQixFQUFFO2dCQUNqQixtQ0FBbUMsRUFBRSxJQUFJO2dCQUN6QyxnQ0FBZ0MsRUFBRSxJQUFJO2FBQ3ZDO1lBQ0QsZUFBZSxFQUFFO2dCQUNmO29CQUNFLFVBQVUsRUFBRSxLQUFLO29CQUNqQixrQkFBa0IsRUFBRTt3QkFDbEIsb0RBQW9ELEVBQUUsSUFBSTtxQkFDM0Q7aUJBQ0Y7Z0JBQ0Q7b0JBQ0UsVUFBVSxFQUFFLEtBQUs7b0JBQ2pCLGtCQUFrQixFQUFFO3dCQUNsQixvREFBb0QsRUFBRSxJQUFJO3FCQUMzRDtpQkFDRjthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsaUJBQWlCO1FBQ2pCLFFBQVEsQ0FBQyxTQUFTLENBQUMsUUFBUSxFQUFFLGlCQUFpQixFQUFFO1lBQzlDLGlCQUFpQixFQUFFLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPO1lBQ2xELFVBQVUsRUFBRSxFQUFFLFlBQVksRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFO1lBQ3RDLGlCQUFpQixFQUFFO2dCQUNqQixtQ0FBbUMsRUFBRSxJQUFJO2dCQUN6QyxnQ0FBZ0MsRUFBRSxJQUFJO2FBQ3ZDO1lBQ0QsZUFBZSxFQUFFO2dCQUNmO29CQUNFLFVBQVUsRUFBRSxLQUFLO29CQUNqQixrQkFBa0IsRUFBRTt3QkFDbEIsb0RBQW9ELEVBQUUsSUFBSTtxQkFDM0Q7aUJBQ0Y7Z0JBQ0Q7b0JBQ0UsVUFBVSxFQUFFLEtBQUs7b0JBQ2pCLGtCQUFrQixFQUFFO3dCQUNsQixvREFBb0QsRUFBRSxJQUFJO3FCQUMzRDtpQkFDRjthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUQsMENBQTBDO1FBQzVDLHdGQUF3RjtRQUN4RixNQUFNLGVBQWUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLDBCQUEwQixFQUFFO1lBQ3RFLFNBQVMsRUFBRSwwQkFBMEI7WUFDckMsZUFBZSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztTQUN0QyxDQUFDLENBQUM7UUFDSCxNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hELFNBQVMsRUFBRSxnQkFBZ0I7WUFDM0IsaUJBQWlCLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQzNDLGVBQWUsRUFBRTtnQkFDZixlQUFlLEVBQUUsQ0FBQztnQkFDbEIsS0FBSyxFQUFFLGVBQWU7YUFDdkI7U0FDRixDQUFDLENBQUM7UUFHSCxzQkFBc0I7UUFDdEIsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQzdELFNBQVMsRUFBRSxnQkFBZ0I7U0FDNUIsQ0FBQyxDQUFDO1FBRUgsdUNBQXVDO1FBQ3ZDLE1BQU0sZUFBZSxHQUFHLElBQUksZ0JBQWdCLENBQUMsZUFBZSxDQUFDLFdBQVcsRUFBRTtZQUN4RSxrQkFBa0IsRUFBRSxJQUFJO1NBQ3pCLENBQUMsQ0FBQztRQUNILGdCQUFnQixDQUFDLGVBQWUsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUVsRCx3RkFBd0Y7UUFDeEYsZ0RBQWdEO1FBQ2hELHdGQUF3RjtRQUN4Riw2RkFBNkY7UUFDN0Ysd0NBQXdDO1FBQ3hDLE1BQU0sQ0FBQyxvQkFBb0I7UUFDekIsaUVBQWlFO1FBQ2pFLEVBQUUsQ0FBQyxTQUFTLENBQUMsa0JBQWtCLEVBQy9CLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQyxnQkFBZ0IsQ0FBQyxFQUFFO1lBQzFDLCtEQUErRDtZQUMvRCxNQUFNLEVBQUUsTUFBTTtTQUNmLENBQUMsQ0FBQztRQUNILHdGQUF3RjtRQUN4RixtREFBbUQ7UUFDbkQsd0ZBQXdGO1FBQ3hGLDBFQUEwRTtRQUMxRSxvQ0FBb0M7UUFDcEMsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLGFBQWEsQ0FBQyxjQUFjLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDeEUsY0FBYyxDQUFDLGNBQWMsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO0lBSW5ELENBQUM7Q0FDRjtBQTNXRCwwRUEyV0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQXR0cmlidXRlVHlwZSwgVGFibGUgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBzM24gZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLW5vdGlmaWNhdGlvbnMnO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXknO1xuaW1wb3J0ICogYXMgY29nbml0byBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29nbml0bydcbi8vIGltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50JztcbmltcG9ydCAqIGFzIHNxcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3FzJztcbmltcG9ydCAqIGFzIGV2ZW50X3NvdXJjZXMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ldmVudC1zb3VyY2VzJztcbmltcG9ydCAqIGFzIHNuc1N1YnNjcmlwdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucy1zdWJzY3JpcHRpb25zJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcblxuZXhwb3J0IGNsYXNzIFJla29nbml0aW9uTGFtYmRhUzNUcmlnZ2VyU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgUzMgQnVja2V0XG4gICAgY29uc3QgYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnQnVja2V0Jywge1xuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlXG4gICAgfSk7XG5cbiAgICBidWNrZXQuYWRkQ29yc1J1bGUoe1xuICAgICAgYWxsb3dlZE1ldGhvZHM6IFtzMy5IdHRwTWV0aG9kcy5HRVQsIHMzLkh0dHBNZXRob2RzLlBVVF0sXG4gICAgICBhbGxvd2VkT3JpZ2luczogW1wiKlwiXSxcbiAgICAgIGFsbG93ZWRIZWFkZXJzOiBbXCIqXCJdLFxuICAgICAgbWF4QWdlOiAzMDAwXG4gICAgfSk7XG5cbiAgICBjb25zdCBpbWFnZUJ1Y2tldEFybiA9IGJ1Y2tldC5idWNrZXRBcm47XG4gICAgLy8gY29uc3Qgd2Vic2l0ZUJ1Y2tldE5hbWUgPSBcImNkay1yZWtuLXB1YmxpY2J1Y2tldFwiXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ29uc3RydWN0IHRvIGNyZWF0ZSBvdXIgQW1hem9uIFMzIEJ1Y2tldCB0byBob3N0IG91ciB3ZWJzaXRlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIGNvbnN0IHdlYkJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgd2Vic2l0ZUJ1Y2tldE5hbWUsIHtcbiAgICAvLyAgIHdlYnNpdGVJbmRleERvY3VtZW50OiAnaW5kZXguaHRtbCcsXG4gICAgLy8gICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIC8vICAgcHVibGljUmVhZEFjY2VzczogdHJ1ZSxcbiAgICAvLyAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlXG4gICAgLy8gfSk7XG4gICAgXG4gICAgLy8gd2ViQnVja2V0LmFkZFRvUmVzb3VyY2VQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgIC8vICAgYWN0aW9uczogWydzMzpHZXRPYmplY3QnXSxcbiAgICAvLyAgIHJlc291cmNlczogW3dlYkJ1Y2tldC5hcm5Gb3JPYmplY3RzKCcqJyldLFxuICAgIC8vICAgcHJpbmNpcGFsczogW25ldyBpYW0uQW55UHJpbmNpcGFsKCldLFxuICAgIC8vICAgY29uZGl0aW9uczoge1xuICAgIC8vICAgICAnSXBBZGRyZXNzJzoge1xuICAgIC8vICAgICAgICdhd3M6U291cmNlSXAnOiBbXG4gICAgLy8gICAgICAgICAnMTAzLjI3LjkuMTA0LzMyJyAvLyBQbGVhc2UgY2hhbmdlIGl0IHRvIHlvdXIgSVAgYWRkcmVzcyBvciBmcm9tIHlvdXIgYWxsb3dlZCBsaXN0XG4gICAgLy8gICAgICAgICBdXG4gICAgLy8gICAgIH1cbiAgICAvLyAgIH1cbiAgICAgIFxuICAgIC8vIH0pKVxuICAgIC8vIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdidWNrZXRVUkwnLCB7IHZhbHVlOiB3ZWJCdWNrZXQuYnVja2V0V2Vic2l0ZURvbWFpbk5hbWUgfSk7XG4gICAgXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERlcGxveSBzaXRlIGNvbnRlbnRzIHRvIFMzIEJ1Y2tldFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnRGVwbG95V2Vic2l0ZScsIHtcbiAgICAvLyAgICAgc291cmNlczogWyBzM2RlcGxveS5Tb3VyY2UuYXNzZXQoJy4vcHVibGljJykgXSxcbiAgICAvLyAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHdlYkJ1Y2tldFxuICAgIC8vIH0pO1xuXG4gICAgLy8gY3JlYXRlIER5bmFtb0RCIHRhYmxlIHRvIGhvbGQgUmVrb2duaXRpb24gcmVzdWx0c1xuICAgIGNvbnN0IHRhYmxlID0gbmV3IFRhYmxlKHRoaXMsICdDbGFzc2lmaWNhdGlvbnMnLCB7XG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2ltYWdlX25hbWUnLFxuICAgICAgICB0eXBlOiBBdHRyaWJ1dGVUeXBlLlNUUklOR1xuICAgICAgfSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1kgLy8gcmVtb3ZlcyB0YWJsZSBvbiBjZGsgZGVzdHJveVxuICAgIH0pO1xuXG5cblxuXG4gICAgLy8gY3JlYXRlIExhbWJkYSBmdW5jdGlvblxuICAgIGNvbnN0IGxhbWJkYUZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnUmVrRnVuY3Rpb24nLCB7XG4gICAgICBoYW5kbGVyOiAncmVrZnVuY3Rpb24uaGFuZGxlcicsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhJykpLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgJ0JVQ0tFVF9OQU1FJzogYnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICAgICdUQUJMRV9OQU1FJzogdGFibGUudGFibGVOYW1lXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBhZGQgUmVrb2duaXRpb24gcGVybWlzc2lvbnMgZm9yIExhbWJkYSBmdW5jdGlvblxuICAgIGNvbnN0IHN0YXRlbWVudCA9IG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KCk7XG4gICAgc3RhdGVtZW50LmFkZEFjdGlvbnMoXCJyZWtvZ25pdGlvbjpEZXRlY3RMYWJlbHNcIik7XG4gICAgc3RhdGVtZW50LmFkZFJlc291cmNlcyhcIipcIik7XG4gICAgbGFtYmRhRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KHN0YXRlbWVudCk7XG5cbiAgICAvLyAvLyBjcmVhdGUgdHJpZ2dlciBmb3IgTGFtYmRhIGZ1bmN0aW9uIHdpdGggaW1hZ2UgdHlwZSBzdWZmaXhlc1xuICAgIC8vIGJ1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsIG5ldyBzM24uTGFtYmRhRGVzdGluYXRpb24obGFtYmRhRnVuY3Rpb24pLHtzdWZmaXg6ICcuanBnJ30pO1xuICAgIC8vIGJ1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsIG5ldyBzM24uTGFtYmRhRGVzdGluYXRpb24obGFtYmRhRnVuY3Rpb24pLHtzdWZmaXg6ICcuanBlZyd9KTtcbiAgICAvLyBidWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oczMuRXZlbnRUeXBlLk9CSkVDVF9DUkVBVEVELCBuZXcgczNuLkxhbWJkYURlc3RpbmF0aW9uKGxhbWJkYUZ1bmN0aW9uKSx7c3VmZml4OiAnLnBuZyd9KTtcblxuICAgIC8vIGdyYW50IHBlcm1pc3Npb25zIGZvciBsYW1iZGEgdG8gcmVhZC93cml0ZSB0byBEeW5hbW9EQiB0YWJsZSBhbmQgYnVja2V0XG4gICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGxhbWJkYUZ1bmN0aW9uKTtcbiAgICBidWNrZXQuZ3JhbnRSZWFkV3JpdGUobGFtYmRhRnVuY3Rpb24pO1xuXHQgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJVcGxvYWRJbWFnZVRvUzNcIiwge1xuICAgICAgdmFsdWU6IGBhd3MgczMgY3AgPGxvY2FsLXBhdGgtdG8taW1hZ2U+IHMzOi8vJHtidWNrZXQuYnVja2V0TmFtZX0vYCxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlVwbG9hZCBhbiBpbWFnZSB0byBTMyAodXNpbmcgQVdTIENMSSkgdG8gdHJpZ2dlciBSZWtvZ25pdGlvblwiLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiRHluYW1vREJUYWJsZVwiLCB7XG4gICAgICB2YWx1ZTogdGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246IFwiVGhpcyBpcyB3aGVyZSB0aGUgaW1hZ2UgUmVrb2duaXRpb24gcmVzdWx0cyB3aWxsIGJlIHN0b3JlZC5cIixcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkxhbWJkYUZ1bmN0aW9uXCIsIHtcbiAgICAgIHZhbHVlOiBsYW1iZGFGdW5jdGlvbi5mdW5jdGlvbk5hbWUsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJMYW1iZGFGdW5jdGlvbkxvZ3NcIiwge1xuICAgICAgdmFsdWU6IGxhbWJkYUZ1bmN0aW9uLmxvZ0dyb3VwLmxvZ0dyb3VwTmFtZSxcbiAgICB9KTtcblxuICAgIC8vY3JlYXRlIHNlcnZpY2UgbGFtYmRhIGZ1bmN0aW9uIFxuXG4gICAgY29uc3Qgc2VydmljZUZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnc2VydmljZUZ1bmN0aW9uJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCdzZXJ2aWNlbGFtYmRhJyksXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM185LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgXCJUQUJMRVwiOiB0YWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFwiQlVDS0VUXCI6IGJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICDigItcbiAgICBidWNrZXQuZ3JhbnRXcml0ZShzZXJ2aWNlRm4pO1xuICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShzZXJ2aWNlRm4pO1xuXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVGhpcyBjb25zdHJ1Y3QgYnVpbGRzIGEgbmV3IEFtYXpvbiBBUEkgR2F0ZXdheSB3aXRoIEFXUyBMYW1iZGEgSW50ZWdyYXRpb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ3cuTGFtYmRhUmVzdEFwaSh0aGlzLCAnaW1hZ2VBUEknLCB7XG4gICAgICBkZWZhdWx0Q29yc1ByZWZsaWdodE9wdGlvbnM6IHtcbiAgICAgICAgYWxsb3dPcmlnaW5zOiBhcGlndy5Db3JzLkFMTF9PUklHSU5TLFxuICAgICAgICBhbGxvd01ldGhvZHM6IGFwaWd3LkNvcnMuQUxMX01FVEhPRFNcbiAgICAgIH0sXG4gICAgICBoYW5kbGVyOiBzZXJ2aWNlRm4sXG4gICAgICBwcm94eTogZmFsc2UsXG4gICAgfSk7XG5cbiAgICBjb25zdCBsYW1iZGFJbnRlZ3JhdGlvbiA9IG5ldyBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbihzZXJ2aWNlRm4sIHtcbiAgICAgIHByb3h5OiBmYWxzZSxcbiAgICAgIHJlcXVlc3RQYXJhbWV0ZXJzOiB7XG4gICAgICAgICdpbnRlZ3JhdGlvbi5yZXF1ZXN0LnF1ZXJ5c3RyaW5nLmFjdGlvbic6ICdtZXRob2QucmVxdWVzdC5xdWVyeXN0cmluZy5hY3Rpb24nLFxuICAgICAgICAnaW50ZWdyYXRpb24ucmVxdWVzdC5xdWVyeXN0cmluZy5rZXknOiAnbWV0aG9kLnJlcXVlc3QucXVlcnlzdHJpbmcua2V5J1xuICAgICAgfSxcbiAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IHtcbiAgICAgICAgJ2FwcGxpY2F0aW9uL2pzb24nOiBKU09OLnN0cmluZ2lmeSh7IGFjdGlvbjogXCIkdXRpbC5lc2NhcGVKYXZhU2NyaXB0KCRpbnB1dC5wYXJhbXMoJ2FjdGlvbicpKVwiLCBrZXk6IFwiJHV0aWwuZXNjYXBlSmF2YVNjcmlwdCgkaW5wdXQucGFyYW1zKCdrZXknKSlcIiB9KVxuICAgICAgfSxcbiAgICAgIHBhc3N0aHJvdWdoQmVoYXZpb3I6IGFwaWd3LlBhc3N0aHJvdWdoQmVoYXZpb3IuV0hFTl9OT19URU1QTEFURVMsXG4gICAgICBpbnRlZ3JhdGlvblJlc3BvbnNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgIC8vIFdlIGNhbiBtYXAgcmVzcG9uc2UgcGFyYW1ldGVyc1xuICAgICAgICAgICAgLy8gLSBEZXN0aW5hdGlvbiBwYXJhbWV0ZXJzICh0aGUga2V5KSBhcmUgdGhlIHJlc3BvbnNlIHBhcmFtZXRlcnMgKHVzZWQgaW4gbWFwcGluZ3MpXG4gICAgICAgICAgICAvLyAtIFNvdXJjZSBwYXJhbWV0ZXJzICh0aGUgdmFsdWUpIGFyZSB0aGUgaW50ZWdyYXRpb24gcmVzcG9uc2UgcGFyYW1ldGVycyBvciBleHByZXNzaW9uc1xuICAgICAgICAgICAgJ21ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogXCInKidcIlxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIC8vIEZvciBlcnJvcnMsIHdlIGNoZWNrIGlmIHRoZSBlcnJvciBtZXNzYWdlIGlzIG5vdCBlbXB0eSwgZ2V0IHRoZSBlcnJvciBkYXRhXG4gICAgICAgICAgc2VsZWN0aW9uUGF0dGVybjogXCIoXFxufC4pK1wiLFxuICAgICAgICAgIHN0YXR1c0NvZGU6IFwiNTAwXCIsXG4gICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAnbWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiBcIicqJ1wiXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICBdLFxuICAgIH0pO1xuXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ29nbml0byBVc2VyIFBvb2wgQXV0aGVudGljYXRpb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgdXNlclBvb2wgPSBuZXcgY29nbml0by5Vc2VyUG9vbCh0aGlzLCBcIlVzZXJQb29sXCIsIHtcbiAgICAgIHNlbGZTaWduVXBFbmFibGVkOiB0cnVlLCAvLyBBbGxvdyB1c2VycyB0byBzaWduIHVwXG4gICAgICBhdXRvVmVyaWZ5OiB7IGVtYWlsOiB0cnVlIH0sIC8vIFZlcmlmeSBlbWFpbCBhZGRyZXNzZXMgYnkgc2VuZGluZyBhIHZlcmlmaWNhdGlvbiBjb2RlXG4gICAgICBzaWduSW5BbGlhc2VzOiB7IHVzZXJuYW1lOiB0cnVlLCBlbWFpbDogdHJ1ZSB9LCAvLyBTZXQgZW1haWwgYXMgYW4gYWxpYXNcbiAgICB9KTtcblxuICAgIGNvbnN0IHVzZXJQb29sQ2xpZW50ID0gbmV3IGNvZ25pdG8uVXNlclBvb2xDbGllbnQodGhpcywgXCJVc2VyUG9vbENsaWVudFwiLCB7XG4gICAgICB1c2VyUG9vbCxcbiAgICAgIGdlbmVyYXRlU2VjcmV0OiBmYWxzZSwgLy8gRG9uJ3QgbmVlZCB0byBnZW5lcmF0ZSBzZWNyZXQgZm9yIHdlYiBhcHAgcnVubmluZyBvbiBicm93c2Vyc1xuICAgIH0pO1xuXG4gICAgY29uc3QgaWRlbnRpdHlQb29sID0gbmV3IGNvZ25pdG8uQ2ZuSWRlbnRpdHlQb29sKHRoaXMsIFwiSW1hZ2VSZWtvZ25pdGlvbklkZW50aXR5UG9vbFwiLCB7XG4gICAgICBhbGxvd1VuYXV0aGVudGljYXRlZElkZW50aXRpZXM6IGZhbHNlLCAvLyBEb24ndCBhbGxvdyB1bmF0aGVudGljYXRlZCB1c2Vyc1xuICAgICAgY29nbml0b0lkZW50aXR5UHJvdmlkZXJzOiBbXG4gICAgICAgIHtcbiAgICAgICAgY2xpZW50SWQ6IHVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICAgIHByb3ZpZGVyTmFtZTogdXNlclBvb2wudXNlclBvb2xQcm92aWRlck5hbWUsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYXV0aCA9IG5ldyBhcGlndy5DZm5BdXRob3JpemVyKHRoaXMsICdBUElHYXRld2F5QXV0aG9yaXplcicsIHtcbiAgICAgIG5hbWU6ICdjdXN0b21lci1hdXRob3JpemVyJyxcbiAgICAgIGlkZW50aXR5U291cmNlOiAnbWV0aG9kLnJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb24nLFxuICAgICAgcHJvdmlkZXJBcm5zOiBbdXNlclBvb2wudXNlclBvb2xBcm5dLFxuICAgICAgcmVzdEFwaUlkOiBhcGkucmVzdEFwaUlkLFxuICAgICAgdHlwZTogYXBpZ3cuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUTyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGF1dGhlbnRpY2F0ZWRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiSW1hZ2VSZWtvZ25pdGlvbkF1dGhlbnRpY2F0ZWRSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5GZWRlcmF0ZWRQcmluY2lwYWwoXG4gICAgICAgIFwiY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tXCIsXG4gICAgICAgICAge1xuICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgICBcImNvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTphdWRcIjogaWRlbnRpdHlQb29sLnJlZixcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiRm9yQW55VmFsdWU6U3RyaW5nTGlrZVwiOiB7XG4gICAgICAgICAgICBcImNvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTphbXJcIjogXCJhdXRoZW50aWNhdGVkXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgXCJzdHM6QXNzdW1lUm9sZVdpdGhXZWJJZGVudGl0eVwiXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgLy8gSUFNIHBvbGljeSBncmFudGluZyB1c2VycyBwZXJtaXNzaW9uIHRvIHVwbG9hZCwgZG93bmxvYWQgYW5kIGRlbGV0ZSB0aGVpciBvd24gcGljdHVyZXNcbiAgICBhdXRoZW50aWNhdGVkUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwiczM6R2V0T2JqZWN0XCIsXG4gICAgICAgICAgXCJzMzpQdXRPYmplY3RcIlxuICAgICAgICBdLFxuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIGltYWdlQnVja2V0QXJuICsgXCIvcHJpdmF0ZS8ke2NvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTpzdWJ9LypcIixcbiAgICAgICAgICBpbWFnZUJ1Y2tldEFybiArIFwiL3ByaXZhdGUvJHtjb2duaXRvLWlkZW50aXR5LmFtYXpvbmF3cy5jb206c3VifVwiLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gSUFNIHBvbGljeSBncmFudGluZyB1c2VycyBwZXJtaXNzaW9uIHRvIGxpc3QgdGhlaXIgcGljdHVyZXNcbiAgICBhdXRoZW50aWNhdGVkUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiczM6TGlzdEJ1Y2tldFwiXSxcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBpbWFnZUJ1Y2tldEFybixcbiAgICAgICAgXSxcbiAgICAgICAgY29uZGl0aW9uczoge1wiU3RyaW5nTGlrZVwiOiB7XCJzMzpwcmVmaXhcIjogW1wicHJpdmF0ZS8ke2NvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTpzdWJ9LypcIl19fVxuICAgICAgfSlcbiAgICApO1xuXG4gICAgbmV3IGNvZ25pdG8uQ2ZuSWRlbnRpdHlQb29sUm9sZUF0dGFjaG1lbnQodGhpcywgXCJJZGVudGl0eVBvb2xSb2xlQXR0YWNobWVudFwiLCB7XG4gICAgICBpZGVudGl0eVBvb2xJZDogaWRlbnRpdHlQb29sLnJlZixcbiAgICAgIHJvbGVzOiB7IGF1dGhlbnRpY2F0ZWQ6IGF1dGhlbnRpY2F0ZWRSb2xlLnJvbGVBcm4gfSxcbiAgICB9KTtcblxuICAgIC8vIEV4cG9ydCB2YWx1ZXMgb2YgQ29nbml0b1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiVXNlclBvb2xJZFwiLCB7XG4gICAgICB2YWx1ZTogdXNlclBvb2wudXNlclBvb2xJZCxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkFwcENsaWVudElkXCIsIHtcbiAgICAgIHZhbHVlOiB1c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiSWRlbnRpdHlQb29sSWRcIiwge1xuICAgICAgdmFsdWU6IGlkZW50aXR5UG9vbC5yZWYsXG4gICAgfSk7XG5cblxuICAgIFxuICAgIFxuICAgIFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgR2F0ZXdheVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBpbWFnZUFQSSA9IGFwaS5yb290LmFkZFJlc291cmNlKCdpbWFnZXMnKTtcbiAgICDigItcbiAgICAvLyBHRVQgL2ltYWdlc1xuICAgIGltYWdlQVBJLmFkZE1ldGhvZCgnR0VUJywgbGFtYmRhSW50ZWdyYXRpb24sIHtcbiAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBhcGlndy5BdXRob3JpemF0aW9uVHlwZS5DT0dOSVRPLFxuICAgICAgYXV0aG9yaXplcjogeyBhdXRob3JpemVySWQ6IGF1dGgucmVmIH0sXG4gICAgICByZXF1ZXN0UGFyYW1ldGVyczoge1xuICAgICAgICAnbWV0aG9kLnJlcXVlc3QucXVlcnlzdHJpbmcuYWN0aW9uJzogdHJ1ZSxcbiAgICAgICAgJ21ldGhvZC5yZXF1ZXN0LnF1ZXJ5c3RyaW5nLmtleSc6IHRydWVcbiAgICAgIH0sXG4gICAgICBtZXRob2RSZXNwb25zZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAnbWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiBcIjUwMFwiLFxuICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgJ21ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICBdXG4gICAgfSk7XG4gICAgXG4gICAgLy8gREVMRVRFIC9pbWFnZXNcbiAgICBpbWFnZUFQSS5hZGRNZXRob2QoJ0RFTEVURScsIGxhbWJkYUludGVncmF0aW9uLCB7XG4gICAgICBhdXRob3JpemF0aW9uVHlwZTogYXBpZ3cuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUTyxcbiAgICAgIGF1dGhvcml6ZXI6IHsgYXV0aG9yaXplcklkOiBhdXRoLnJlZiB9LFxuICAgICAgcmVxdWVzdFBhcmFtZXRlcnM6IHtcbiAgICAgICAgJ21ldGhvZC5yZXF1ZXN0LnF1ZXJ5c3RyaW5nLmFjdGlvbic6IHRydWUsXG4gICAgICAgICdtZXRob2QucmVxdWVzdC5xdWVyeXN0cmluZy5rZXknOiB0cnVlXG4gICAgICB9LFxuICAgICAgbWV0aG9kUmVzcG9uc2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgJ21ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogXCI1MDBcIixcbiAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICdtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfVxuICAgICAgXVxuICAgIH0pO1xuXG4gICAgICAvLyBCdWlsZGluZyBTUVMgcXVldWUgYW5kIERlYWRMZXR0ZXIgUXVldWVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnSW1nVXBsb2FkRGVhZExldHRlclF1ZXVlJywge1xuICAgICAgcXVldWVOYW1lOiAnSW1nVXBsb2FkRGVhZExldHRlclF1ZXVlJyxcbiAgICAgIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoNylcbiAgICB9KTtcbiAgICBjb25zdCB1cGxvYWRRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ0ltZ1VwbG9hZFF1ZXVlJywge1xuICAgICAgcXVldWVOYW1lOiAnSW1nVXBsb2FkUXVldWUnLFxuICAgICAgdmlzaWJpbGl0eVRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGRlYWRMZXR0ZXJRdWV1ZToge1xuICAgICAgICBtYXhSZWNlaXZlQ291bnQ6IDEsXG4gICAgICAgIHF1ZXVlOiBkZWFkTGV0dGVyUXVldWVcbiAgICAgIH1cbiAgICB9KTtcblxuXG4gICAgLy8gQ3JlYXRlIGEgU05TIFRvcGljLlxuICAgIGNvbnN0IHVwbG9hZEV2ZW50VG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdJbWdVcGxvYWRUb3BpYycsIHtcbiAgICAgIHRvcGljTmFtZTogJ0ltZ1VwbG9hZFRvcGljJ1xuICAgIH0pO1xuXG4gICAgLy8gQmluZCB0aGUgU1FTIFF1ZXVlIHRvIHRoZSBTTlMgVG9waWMuXG4gICAgY29uc3Qgc3FzU3Vic2NyaXB0aW9uID0gbmV3IHNuc1N1YnNjcmlwdGlvbnMuU3FzU3Vic2NyaXB0aW9uKHVwbG9hZFF1ZXVlLCB7XG4gICAgICByYXdNZXNzYWdlRGVsaXZlcnk6IHRydWVcbiAgICB9KTtcbiAgICB1cGxvYWRFdmVudFRvcGljLmFkZFN1YnNjcmlwdGlvbihzcXNTdWJzY3JpcHRpb24pO1xuICAgIFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBCdWlsZGluZyBTMyBCdWNrZXQgQ3JlYXRlIE5vdGlmaWNhdGlvbiB0byBTUVNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gYnVja2V0LmFkZE9iamVjdENyZWF0ZWROb3RpZmljYXRpb24obmV3IHMzbi5TcXNEZXN0aW5hdGlvbihxdWV1ZSksIHsgcHJlZml4OiAncHJpdmF0ZS8nIH0pXG4gICAgLy8gQmluZHMgdGhlIFMzIGJ1Y2tldCB0byB0aGUgU05TIFRvcGljLlxuICAgIGJ1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihcbiAgICAgIC8vIE1vZGlmeSB0aGUgYHMzLkV2ZW50VHlwZS4qYCB0byBoYW5kbGUgb3RoZXIgb2JqZWN0IG9wZXJhdGlvbnMuXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURURfUFVULFxuICAgICAgbmV3IHMzbi5TbnNEZXN0aW5hdGlvbih1cGxvYWRFdmVudFRvcGljKSwge1xuICAgICAgLy8gVGhlIHRyaWdnZXIgd2lsbCBvbmx5IGZpcmUgb24gZmlsZXMgd2l0aCB0aGUgLmNzdiBleHRlbnNpb24uXG4gICAgICBzdWZmaXg6ICcucG5nJ1xuICAgIH0pO1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGEoUmVrb2duaXRpb24pIHRvIGNvbnN1bWUgbWVzc2FnZXMgZnJvbSBTUVNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gbGFtYmRhRnVuY3Rpb24uYWRkRXZlbnRTb3VyY2UobmV3IGV2ZW50X3NvdXJjZXMuU3FzRXZlbnRTb3VyY2UocXVldWUpKTtcbiAgICAvLyBCaW5kIHRoZSBMYW1iZGEgdG8gdGhlIFNRUyBRdWV1ZS5cbiAgICBjb25zdCBpbnZva2VFdmVudFNvdXJjZSA9IG5ldyBldmVudF9zb3VyY2VzLlNxc0V2ZW50U291cmNlKHVwbG9hZFF1ZXVlKTtcbiAgICBsYW1iZGFGdW5jdGlvbi5hZGRFdmVudFNvdXJjZShpbnZva2VFdmVudFNvdXJjZSk7XG5cbiAgICBcblxuICB9XG59XG4iXX0=