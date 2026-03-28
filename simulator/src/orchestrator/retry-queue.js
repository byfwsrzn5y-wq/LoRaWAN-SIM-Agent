class RetryQueue {
  constructor() {
    this.jobs = new Map();
  }

  static nextDelayMs(attempt) {
    const schedule = [5000, 15000, 60000, 300000, 900000];
    const idx = Math.max(0, Math.min(schedule.length - 1, attempt - 1));
    return schedule[idx];
  }

  enqueue(job) {
    const base = {
      attempt: 0,
      maxAttempts: 8,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date().toISOString(),
      ...job,
    };
    this.jobs.set(base.jobId, base);
    return base;
  }

  list() {
    return Array.from(this.jobs.values());
  }

  get(jobId) {
    return this.jobs.get(jobId) || null;
  }

  markSuccess(jobId) {
    this.jobs.delete(jobId);
  }

  markFailure(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.attempt += 1;
    if (job.attempt >= job.maxAttempts) {
      job.dead = true;
      job.nextRunAt = null;
      return job;
    }
    const delay = RetryQueue.nextDelayMs(job.attempt);
    job.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.jobs.set(jobId, job);
    return job;
  }
}

module.exports = { RetryQueue };
