import * as cdk from 'aws-cdk-lib';
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from "constructs";
import * as path from 'path';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito'
// import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as event_sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sns from 'aws-cdk-lib/aws-sns';

export class RekognitionLambdaS3TriggerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
    const table = new Table(this, 'Classifications', {
      partitionKey: {
        name: 'image_name',
        type: AttributeType.STRING
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
    ​
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
      selfSignUpEnabled: true, // Allow users to sign up
      autoVerify: { email: true }, // Verify email addresses by sending a verification code
      signInAliases: { username: true, email: true }, // Set email as an alias
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false, // Don't need to generate secret for web app running on browsers
    });

    const identityPool = new cognito.CfnIdentityPool(this, "ImageRekognitionIdentityPool", {
      allowUnauthenticatedIdentities: false, // Don't allow unathenticated users
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
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
          {
          StringEquals: {
              "cognito-identity.amazonaws.com:aud": identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    // IAM policy granting users permission to upload, download and delete their own pictures
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:PutObject"
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}",
        ],
      })
    );

    // IAM policy granting users permission to list their pictures
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        effect: iam.Effect.ALLOW,
        resources: [
          imageBucketArn,
        ],
        conditions: {"StringLike": {"s3:prefix": ["private/${cognito-identity.amazonaws.com:sub}/*"]}}
      })
    );

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
    ​
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
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.SnsDestination(uploadEventTopic), {
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
