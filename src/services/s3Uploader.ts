import { S3Client, PutObjectCommand, PutObjectCommandInput } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { consoleLogger } from '../logs.js';

const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const s3Client = new S3Client({ region: REGION });

export interface UploadedFileInfo {
  filename: string;
  s3Path: string;
  uploadedUrl: string;
}

export interface ScanMetadata {
  scanId: string;
  userId: string;
  email: string;
  messageId?: string;
  amplitudeUserId?: string;
  deviceId?: string;
  orgId?: string;
  userRole?: string;
  siteName?: string;
  durationExceeded?: string;
}

export const uploadFileToS3 = async (
  localFilePath: string,
  s3Key: string,
  metadata?: Record<string, string>,
): Promise<string> => {
  const fileStream = fs.readFileSync(localFilePath);
  const contentType = mime.lookup(localFilePath) || 'application/octet-stream';

  const uploadParams: PutObjectCommandInput = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: s3Key,
    Body: fileStream,
    ContentType: contentType,
    ...(metadata && { Metadata: metadata }),
  };

  const command = new PutObjectCommand(uploadParams);
  await s3Client.send(command);

  const uploadedUrl = process.env.CLOUDFRONT_BASE_URL
    ? `${process.env.CLOUDFRONT_BASE_URL}/${s3Key}`
    : `https://${process.env.S3_BUCKET_NAME}.s3.${REGION}.amazonaws.com/${s3Key}`;

  return uploadedUrl;
};

function getAllFiles(dir: string, rootDir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  return entries.reduce((files: string[], entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return files.concat(getAllFiles(fullPath, rootDir));
    }
    const relativePath = path.relative(rootDir, fullPath);
    return files.concat(relativePath);
  }, []);
}

export const uploadFolderToS3 = async (
  localFolderPath: string,
  s3Prefix: string,
  scanMetadata: ScanMetadata,
): Promise<UploadedFileInfo[]> => {
  const uploadedFiles: UploadedFileInfo[] = [];
  const files = getAllFiles(localFolderPath, localFolderPath);
  const allowedFileExtRegex = /\.(html|csv|pdf|zip)$/;

  const metadata: Record<string, string> = {
    scanid: scanMetadata.scanId,
    userid: scanMetadata.userId,
    useremail: scanMetadata.email,
  };

  // Add optional metadata fields if present
  if (scanMetadata.messageId) {
    metadata.messageid = scanMetadata.messageId;
  }
  if (scanMetadata.amplitudeUserId) {
    metadata.amplitudeuserid = scanMetadata.amplitudeUserId;
  }
  if (scanMetadata.deviceId) {
    metadata.deviceid = scanMetadata.deviceId;
  }
  if (scanMetadata.orgId) {
    metadata.orgid = scanMetadata.orgId;
  }
  if (scanMetadata.userRole) {
    metadata.userrole = scanMetadata.userRole;
  }
  if (scanMetadata.siteName) {
    metadata.sitename = scanMetadata.siteName;
  }
  if (scanMetadata.durationExceeded !== undefined) {
    metadata.durationexceeded = scanMetadata.durationExceeded;
  }

  consoleLogger.info(`Uploading ${files.length} files to S3...`);

  const uploadPromises = files.map(async relativePath => {
    const fullPath = path.join(localFolderPath, relativePath);
    const s3Path = `${s3Prefix}/${relativePath.replace(/\\/g, '/')}`;

    try {
      const uploadedUrl = await uploadFileToS3(fullPath, s3Path, metadata);

      consoleLogger.info(`Uploaded: ${relativePath}`);

      if (allowedFileExtRegex.test(relativePath)) {
        return {
          filename: relativePath,
          s3Path,
          uploadedUrl,
        };
      }
      return null;
    } catch (err) {
      const e = err as Error;
      consoleLogger.error(`Failed to upload ${relativePath}: ${e.message}`);
      throw new Error(`Failed to upload files to S3: ${e.message}`);
    }
  });

  const results = await Promise.all(uploadPromises);
  uploadedFiles.push(...results.filter((file): file is UploadedFileInfo => file !== null));

  consoleLogger.info(`Successfully uploaded ${uploadedFiles.length} files to S3 at ${s3Prefix}`);

  return uploadedFiles;
};

export const isS3UploadEnabled = (): boolean => {
  return !!(
    process.env.S3_BUCKET_NAME &&
    process.env.OOBEE_SCAN_ID &&
    process.env.OOBEE_USER_ID &&
    process.env.OOBEE_USER_EMAIL
  );
};

export const getS3MetadataFromEnv = (
  siteName: string | undefined,
  durationExceeded: boolean,
): ScanMetadata | null => {
  const scanId = process.env.OOBEE_SCAN_ID;
  const userId = process.env.OOBEE_USER_ID;
  const email = process.env.OOBEE_USER_EMAIL;

  if (!scanId || !userId || !email) {
    return null;
  }

  return {
    scanId,
    userId,
    email,
    messageId: process.env.OOBEE_MESSAGE_ID,
    amplitudeUserId: process.env.OOBEE_AMPLITUDE_USER_ID,
    deviceId: process.env.OOBEE_DEVICE_ID,
    orgId: process.env.OOBEE_ORG_ID,
    userRole: process.env.OOBEE_USER_ROLE,
    siteName,
    durationExceeded: durationExceeded ? 'true' : undefined,
  };
};

export const getS3UploadPrefix = (): string | null => {
  const scanId = process.env.OOBEE_SCAN_ID;
  const userId = process.env.OOBEE_USER_ID;

  if (!scanId || !userId) {
    return null;
  }

  return `users/${userId}/scans/${scanId}`;
};