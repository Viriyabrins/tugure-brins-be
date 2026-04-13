import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://202.155.91.210:9011',
  credentials: {
    accessKeyId: 'sibernetik',
    secretAccessKey: 'V1R1y4#123',
  },
  forcePathStyle: true,
});

try {
  const command = new ListObjectsV2Command({
    Bucket: 'brins',
    Prefix: 'test/',
    MaxKeys: 5,
  });

  const response = await s3Client.send(command);
  console.log('SUCCESS:', JSON.stringify(response, null, 2));
} catch (err) {
  console.error('ERROR:', err.message);
  console.error('Error Code:', err.Code);
  if (err.$response) {
    console.error('Raw response:', err.$response);
  }
}
