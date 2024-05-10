# Image Recognition Application with Cloud Native Architecture

Make sure to setup access keys and configure aws using aws-cli before you begin the process.

First, you will need to install the AWS CDK:

```
$ npm install -g aws-cdk
```

Install the required dependencies:

```
$ npm install
```

At this point you can build and then synthesize the CloudFormation template for this code.

```
$ npm run build
$ cdk synth
$ cdk deploy
```
