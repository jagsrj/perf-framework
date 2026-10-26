// This module generates a unique runId based on the current timestamp and a random suffix.
import { randomBytes } from 'crypto';

export function generateRunId() {
    const timestamp = Date.now().toString();
    const randomSuffix = randomBytes(4).toString('hex');
    return `${timestamp}-${randomSuffix}`;
}