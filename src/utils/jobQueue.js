import { v4 as uuidv4 } from 'uuid';

/**
 * In-memory job queue for tracking bulk debtor actions
 * Each job tracks: status, total count, processed count, failed count, errors
 */

const jobs = new Map();

/**
 * Create a new job and return job ID
 * @param {Object} meta - Job metadata
 * @returns {string} jobId
 */
export function createJob(meta = {}) {
  const jobId = uuidv4();
  jobs.set(jobId, {
    id: jobId,
    status: 'PENDING', // PENDING | PROCESSING | COMPLETED | FAILED
    totalCount: meta.totalCount || 0,
    processedCount: 0,
    failedCount: 0,
    currentDebtorId: null,
    message: meta.message || 'Job created',
    errors: [],
    action: meta.action, // 'check' | 'approve' | 'revision'
    batchId: meta.batchId,
    startedAt: new Date(),
    completedAt: null,
  });
  return jobId;
}

/**
 * Get job status by ID
 * @param {string} jobId
 * @returns {Object} job or null
 */
export function getJobStatus(jobId) {
  if (!jobs.has(jobId)) return null;
  
  const job = jobs.get(jobId);
  const percentage = job.totalCount > 0 ? Math.round((job.processedCount / job.totalCount) * 100) : 0;
  
  return {
    ...job,
    percentage,
    elapsedMs: new Date() - job.startedAt,
  };
}

/**
 * Update job progress
 * @param {string} jobId
 * @param {Object} updates - fields to update
 */
export function updateJob(jobId, updates) {
  if (!jobs.has(jobId)) {
    console.warn(`Job ${jobId} not found`);
    return;
  }
  
  const job = jobs.get(jobId);
  const updated = { ...job, ...updates };
  jobs.set(jobId, updated);
}

/**
 * Mark job as completed
 * @param {string} jobId
 * @param {Object} finalData - final status data
 */
export function completeJob(jobId, finalData = {}) {
  if (!jobs.has(jobId)) return;
  
  const job = jobs.get(jobId);
  jobs.set(jobId, {
    ...job,
    ...finalData,
    status: finalData.status || 'COMPLETED',
    completedAt: new Date(),
  });
}

/**
 * Delete old jobs (cleanup)
 * Removes jobs older than specified duration (default 24 hours)
 * @param {number} olderThanMs - milliseconds (default 86400000 = 24h)
 */
export function cleanupOldJobs(olderThanMs = 86400000) {
  const now = new Date();
  let deleted = 0;
  
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.startedAt > olderThanMs) {
      jobs.delete(jobId);
      deleted++;
    }
  }
  
  return deleted;
}

/**
 * Get all active jobs (for monitoring)
 * @returns {Array} array of active jobs
 */
export function getActiveJobs() {
  return Array.from(jobs.values()).filter(j => j.status !== 'COMPLETED' && j.status !== 'FAILED');
}

/**
 * Delete a job by ID (manual cleanup)
 * @param {string} jobId
 */
export function deleteJob(jobId) {
  jobs.delete(jobId);
}

export default {
  createJob,
  getJobStatus,
  updateJob,
  completeJob,
  cleanupOldJobs,
  getActiveJobs,
  deleteJob,
};
