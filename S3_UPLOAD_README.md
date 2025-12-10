# S3 Upload Integration

This document explains how to use the S3 upload feature in the Oobee engine.

## Overview

The Oobee engine can now automatically upload scan results to Amazon S3 after completing a scan. This enables integration with cloud-based workflows and event-driven architectures:

1. Oobee runs and generates scan results locally
2. Results are automatically uploaded to S3 with metadata
3. S3 events can trigger downstream processing (e.g., serverless functions)
4. External systems can process results and update databases, send notifications, etc.

## Environment Variables

To enable S3 upload, set the following environment variables before running Oobee:

### Required Variables

```bash
# AWS Configuration
export AWS_REGION="ap-southeast-1"                    # AWS region
export AWS_ACCESS_KEY_ID="your-access-key"           # AWS credentials
export AWS_SECRET_ACCESS_KEY="your-secret-key"       # AWS credentials
export S3_BUCKET_NAME="oobee-scan-results"           # S3 bucket name

# Scan Metadata (provided by your orchestration system)
export OOBEE_SCAN_ID="uuid-scan-id"                  # Unique scan identifier
export OOBEE_USER_ID="uuid-user-id"                  # User identifier
export OOBEE_USER_EMAIL="user@example.com"           # User email

# Optional Variables
export CLOUDFRONT_BASE_URL="https://cdn.example.com" # CloudFront distribution URL
```

### S3 Upload Path

Files will be uploaded to: `s3://{bucket}/users/{userId}/scans/{scanId}/`

Example: `s3://oobee-scan-results/users/550e8400-e29b-41d4-a716-446655440000/scans/650e8400-e29b-41d4-a716-446655440001/`

## Usage

### 1. Automated Workflow (Containerized/Orchestrated)

When running Oobee in a containerized or orchestrated environment, pass the required environment variables to the container:

```bash
# Docker example
docker run -e OOBEE_SCAN_ID="650e8400-e29b-41d4-a716-446655440001" \
           -e OOBEE_USER_ID="550e8400-e29b-41d4-a716-446655440000" \
           -e OOBEE_USER_EMAIL="user@example.com" \
           -e S3_BUCKET_NAME="oobee-scan-results" \
           -e AWS_REGION="ap-southeast-1" \
           oobee-engine:latest

# Kubernetes example
env:
  - name: OOBEE_SCAN_ID
    value: "650e8400-e29b-41d4-a716-446655440001"
  - name: OOBEE_USER_ID
    value: "550e8400-e29b-41d4-a716-446655440000"
  - name: OOBEE_USER_EMAIL
    value: "user@example.com"
  - name: S3_BUCKET_NAME
    value: "oobee-scan-results"
  - name: AWS_REGION
    value: "ap-southeast-1"
```

### 2. From CLI (Manual Testing)

```bash
# Set environment variables
export AWS_REGION="ap-southeast-1"
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
### 3. Without S3 Upload (Default Behavior)

If environment variables are not set, Oobee works as before:
- Results are saved locally only
- No S3 upload occurs
- No errors (logs informational message)

```bash
# Run normally without S3 variables
npm run cli -- -c website -u https://example.com
```
If environment variables are not set, Oobee will work as before:
- Results are saved locally
- No S3 upload occurs
- No errors or warnings (except info log)

```bash
# Just run normally without S3 variables
npm run cli -- -c website -u https://example.com
```

## Implementation Details

### Files Uploaded

The S3 uploader uploads all files from the results directory, but only tracks these file types in the response:
- `.html` - HTML reports
- `.csv` - CSV data files
- `.pdf` - PDF reports
- `.zip` - Zipped scan results

All files are uploaded with S3 metadata containing:
- `scanid` - Scan ID
- `userid` - User ID
- `useremail` - User email

### S3 Metadata

Each uploaded file includes metadata that the S3 Lambda processor uses:

```javascript
{
  "scanid": "650e8400-e29b-41d4-a716-446655440001",
  "userid": "550e8400-e29b-41d4-a716-446655440000",
  "useremail": "user@example.com",
}
```

### Error Handling

- If S3 upload fails, the scan continues normally
- Error is logged but doesn't fail the scan
- Results are still available locally
- User can retry upload manually if needed

### Key Functions

#### `isS3UploadEnabled()`
Checks if all required environment variables are set.

#### `getS3MetadataFromEnv()`
Extracts scan metadata from environment variables.

#### `getS3UploadPrefix()`
Generates the S3 path: `users/{userId}/scans/{scanId}`

#### `uploadFolderToS3(localPath, s3Prefix, metadata)`
Uploads entire results folder to S3 with metadata.

## Testing

### Local Testing

1. Create a test S3 bucket:
```bash
aws s3 mb s3://oobee-test-scan-results
```

2. Set test environment variables:
```bash
export S3_BUCKET_NAME="oobee-test-scan-results"
export OOBEE_SCAN_ID="test-$(date +%s)"
export OOBEE_USER_ID="test-user-123"
export OOBEE_USER_EMAIL="test@example.com"
```

3. Run a test scan:
```bash
npm run cli -- -c website -u https://example.com -p 5
```

4. Verify upload:
```bash
aws s3 ls s3://oobee-test-scan-results/users/test-user-123/scans/
```
