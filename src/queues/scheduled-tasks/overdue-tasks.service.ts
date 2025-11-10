import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Task } from '../../modules/tasks/entities/task.entity';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum';
import { DistributedLockService } from '../../common/services/distributed-lock.service';

@Injectable()
export class OverdueTasksService {
  private readonly logger = new Logger(OverdueTasksService.name);
  private readonly LOCK_KEY = 'cron:overdue-tasks-check';
  private readonly LOCK_TTL = 10 * 60 * 1000; // 10 minutes (longer than cron interval)

  constructor(
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    private readonly lockService: DistributedLockService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkOverdueTasks() {
    // Use distributed lock to ensure only one instance processes this cron job
    const result = await this.lockService.withLock(
      this.LOCK_KEY,
      async () => {
        return await this.processOverdueTasks();
      },
      {
        ttl: this.LOCK_TTL,
        retries: 0, // Don't retry - if another instance has the lock, skip this run
      }
    );

    if (result === null) {
      this.logger.debug(
        'Overdue tasks check skipped - another instance is already processing'
      );
    }
  }

  private async processOverdueTasks() {
    try {
      this.logger.debug('Starting overdue tasks check...');
      
      const now = new Date();
      const batchSize = 100; // Process tasks in batches to avoid memory issues
      let processedCount = 0;
      let failedCount = 0;

      // Find overdue tasks
      const overdueTasks = await this.tasksRepository.find({
        where: {
          dueDate: LessThan(now),
          status: TaskStatus.PENDING,
        },
        order: { dueDate: 'ASC' }, // Process oldest overdue tasks first
      });

      if (overdueTasks.length === 0) {
        this.logger.debug('No overdue tasks found');
        return;
      }

      this.logger.log(`Found ${overdueTasks.length} overdue tasks to process`);

      // Process tasks in batches
      for (let i = 0; i < overdueTasks.length; i += batchSize) {
        const batch = overdueTasks.slice(i, i + batchSize);
        const jobs = batch.map(task => ({
          name: 'process-overdue-task',
          data: {
            taskId: task.id,
            dueDate: task.dueDate,
            isOverdue: true
          },
          opts: {
            priority: 2, // Higher priority for overdue tasks
            attempts: 3, // Retry up to 3 times
            backoff: {
              type: 'exponential',
              delay: 5000 // Start with 5 seconds delay between retries
            }
          }
        }));

        try {
          // Add batch to queue
          await this.taskQueue.addBulk(jobs);
          processedCount += batch.length;
          
          this.logger.debug(
            `Queued batch of ${batch.length} tasks (${processedCount}/${overdueTasks.length} total)`
          );
        } catch (error) {
          failedCount += batch.length;
          this.logger.error(
            'Failed to queue batch of overdue tasks',
            error instanceof Error ? error.stack : String(error)
          );
        }
      }

      this.logger.log(
        `Overdue tasks check completed. ` +
        `Successfully queued: ${processedCount}, ` +
        `Failed to queue: ${failedCount}`
      );

      return { processedCount, failedCount };
    } catch (error) {
      this.logger.error(
        'Error during overdue tasks check',
        error instanceof Error ? error.stack : String(error)
      );
      throw error; // Let NestJS handle the error
    }
  }
} 