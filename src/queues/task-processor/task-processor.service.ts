import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TasksService } from '../../modules/tasks/tasks.service';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum';

@Injectable()
@Processor('task-processing')
export class TaskProcessorService extends WorkerHost {
  private readonly logger = new Logger(TaskProcessorService.name);

  constructor(private readonly tasksService: TasksService) {
    super();
  }

  // Improved worker entrypoint
  // - Uses a handler map for clarity
  // - Executes handlers with a timeout to avoid stuck jobs
  // - Provides structured logging and rethrows errors so BullMQ can apply retry/backoff
  // - Supports handler-level failure signaling (return { success: false, ... })
  async process(job: Job): Promise<any> {
    this.logger.debug(`Processing job ${job.id} of type ${job.name}`);

    const handlers: Record<string, (job: Job) => Promise<any>> = {
      'task-status-update': this.handleStatusUpdate.bind(this),
      'overdue-tasks-notification': this.handleOverdueTasks.bind(this),
      'process-overdue-task': this.handleProcessOverdueTask.bind(this),
    };

    const handler = handlers[job.name];
    if (!handler) {
      this.logger.warn(`Unknown job type: ${job.name}`);
      return { success: false, error: 'Unknown job type' };
    }

  // Determine timeout: prefer job.opts.timeout (ms) when provided, otherwise default
  const DEFAULT_TIMEOUT_MS = 30000;
  // job.opts may be undefined in some versions/types; guard access
  const timeoutMs = (job.opts && (job.opts as any).timeout) || DEFAULT_TIMEOUT_MS;

    try {
      const result = await Promise.race([
        handler(job),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Job timed out')), timeoutMs)),
      ]);

      // If handler returns a failure object, throw to trigger retry/backoff
      if (result && typeof result === 'object' && result.success === false) {
        const msg = result.error || 'Handler reported failure';
        this.logger.warn(`Job ${job.id} handler returned failure: ${msg}`);
        throw new Error(msg);
      }

      this.logger.debug(`Job ${job.id} completed successfully`);
      return result;
    } catch (err) {
      this.logger.error(`Error processing job ${job.id} (${job.name}): ${err instanceof Error ? err.message : String(err)}`);
      // Rethrow so BullMQ can apply its retry/backoff policy configured at job enqueue
      throw err;
    }
  }

  private async handleStatusUpdate(job: Job) {
    const { taskId, status } = job.data || {};

    if (!taskId || !status) {
      this.logger.warn('task-status-update missing taskId or status');
      // Treat as fatal/permanent - skip retry by marking as handled
      return { success: true, message: 'Missing required data - skipped' };
    }

    // Validate status value
    const allowed = Object.values(TaskStatus) as string[];
    if (!allowed.includes(status)) {
      this.logger.warn(`task-status-update received invalid status: ${status}`);
      // Invalid payload - skip retry
      return { success: true, message: `Invalid status '${status}' - skipped` };
    }

    try {
      const task = await this.tasksService.updateStatus(taskId, status);

      return {
        success: true,
        taskId: task.id,
        newStatus: task.status,
      };
    } catch (err) {
      if (err instanceof NotFoundException) {
        this.logger.warn(`task-status-update: task ${taskId} not found, skipping`);
        // Task doesn't exist anymore - nothing to retry
        return { success: true, message: 'Task not found - skipped' };
      }

      this.logger.error(`Error updating status for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      // Re-throw to allow BullMQ to apply retry/backoff
      throw err;
    }
  }

  private async handleOverdueTasks(job: Job) {
    this.logger.debug('Processing overdue tasks notification');

    const taskIds: string[] = job.data?.taskIds || job.data?.tasks || [];

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      this.logger.warn('overdue-tasks-notification received without taskIds');
      return { success: true, processed: 0, skipped: 0 };
    }

    const BATCH_SIZE = 50;
    let processed = 0;
    let skipped = 0;

    for (let i = 0; i < taskIds.length; i += BATCH_SIZE) {
      const batch = taskIds.slice(i, i + BATCH_SIZE);

      // Resolve tasks in parallel for the batch
      const results = await Promise.allSettled(batch.map(id => this.tasksService.findOne(id)));

      for (const res of results) {
        if (res.status === 'fulfilled') {
          // Here we could enqueue notifications or update states; for now we count them
          processed += 1;
        } else {
          const reason = res.reason;
          // If task not found, skip; otherwise treat as transient error and rethrow
          if (reason instanceof NotFoundException) {
            skipped += 1;
            this.logger.debug('Overdue task not found, skipping');
          } else {
            this.logger.error(`Transient error while processing overdue tasks: ${reason instanceof Error ? reason.message : String(reason)}`);
            // Rethrow to allow the queue to retry this job
            throw reason;
          }
        }
      }
    }

    this.logger.log(`Overdue tasks processed: ${processed}, skipped (not found): ${skipped}`);
    return { success: true, processed, skipped };
  }

  private async handleProcessOverdueTask(job: Job) {
    const { taskId } = job.data || {};

    if (!taskId) {
      this.logger.warn('process-overdue-task received without taskId');
      return { success: false, error: 'Missing taskId' };
    }

    try {
      // Ensure the task exists before marking or notifying
      const task = await this.tasksService.findOne(taskId);
      this.logger.debug(`process-overdue-task: verified task ${task.id}`);

      // Minimal behavior: confirm existence and let other systems handle notifications.
      return { success: true, taskId: task.id };
    } catch (err) {
      this.logger.error(
        `Error handling process-overdue-task for ${taskId}: ${err instanceof Error ? err.message : String(err)}`
      );
      // Re-throw so BullMQ can apply retry/backoff configured on the job
      throw err;
    }
  }
} 