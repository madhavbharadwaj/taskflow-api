import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Task } from './entities/task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TaskStatus } from './enums/task-status.enum';
import { User } from '../users/entities/user.entity';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
  ) {}

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    // Validate that the user exists before creating the task
    const userExists = await this.usersRepository.findOne({ where: { id: createTaskDto.userId } });
    if (!userExists) {
      throw new BadRequestException(`User with ID ${createTaskDto.userId} not found`);
    }

    // Perform the DB insert within a transaction so we only enqueue after success.
    const result = await this.tasksRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Task);

      const taskPayload: Partial<Task> = { ...createTaskDto } as Partial<Task>;
      if (createTaskDto.dueDate) {
        taskPayload.dueDate = new Date(createTaskDto.dueDate as any);
      }

      const task = repo.create(taskPayload as Partial<Task>);
      return repo.save(task);
    });

    // Enqueue after successful commit so we don't enqueue jobs for rolled-back changes
    this.taskQueue.add('task-status-update', {
      taskId: result.id,
      status: result.status,
    });

    return result;
  }

  async findAll(filter?: import('./dto/task-filter.dto').TaskFilterDto): Promise<{ data: Task[]; count: number }> {
    // Build a query using QueryBuilder so filtering is performed at the DB level
    const qb = this.tasksRepository.createQueryBuilder('task')
      .leftJoinAndSelect('task.user', 'user');

    if (filter) {
      if (filter.status) {
        qb.andWhere('task.status = :status', { status: filter.status });
      }
      if (filter.priority) {
        qb.andWhere('task.priority = :priority', { priority: filter.priority });
      }
      if (filter.userId) {
        qb.andWhere('task.userId = :userId', { userId: filter.userId });
      }
      if (filter.search) {
        qb.andWhere('(task.title ILIKE :search OR task.description ILIKE :search)', { search: `%${filter.search}%` });
      }
      if (filter.dueBefore) {
        qb.andWhere('task.dueDate < :dueBefore', { dueBefore: new Date(filter.dueBefore as any) });
      }
      if (filter.dueAfter) {
        qb.andWhere('task.dueDate > :dueAfter', { dueAfter: new Date(filter.dueAfter as any) });
      }
    }

    const page = filter?.page || 1;
    const limit = filter?.limit || 10;
    qb.skip((page - 1) * limit).take(limit);

    const [data, count] = await qb.getManyAndCount();
    return { data, count };
  }

  async findOne(id: string): Promise<Task> {
    // Use a single DB call to fetch the task with relations and fail if not found
    const task = await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    if (!task) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }

    return task;
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    // Validate that the user exists if userId is being updated
    if (updateTaskDto.userId) {
      const userExists = await this.usersRepository.findOne({ where: { id: updateTaskDto.userId } });
      if (!userExists) {
        throw new BadRequestException(`User with ID ${updateTaskDto.userId} not found`);
      }
    }

    // Use a transaction for the DB update to ensure consistency.
    // We still add to the queue after commit so the job processor sees the final state.
    const result = await this.tasksRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Task);

      // Load existing task with relations
      const task = await repo.findOne({ where: { id }, relations: ['user'] });
      if (!task) {
        throw new NotFoundException(`Task with ID ${id} not found`);
      }

      const originalStatus = task.status;

      // Apply updates
      if (updateTaskDto.title) task.title = updateTaskDto.title;
      if (updateTaskDto.description) task.description = updateTaskDto.description;
      if (updateTaskDto.status) task.status = updateTaskDto.status;
      if (updateTaskDto.priority) task.priority = updateTaskDto.priority;
      if (updateTaskDto.dueDate) task.dueDate = new Date(updateTaskDto.dueDate as any);
      if (updateTaskDto.userId) task.userId = updateTaskDto.userId;

      const saved = await repo.save(task);

      // Return both saved entity and whether status changed so caller can enqueue after commit
      return { saved, statusChanged: originalStatus !== saved.status };
    });

    // After transaction commits, add to queue if status changed
    if (result.statusChanged) {
      this.taskQueue.add('task-status-update', {
        taskId: result.saved.id,
        status: result.saved.status,
      });
    }

    return result.saved;
  }

  async remove(id: string): Promise<void> {
    // Use a single delete call to remove the entity by id.
    // Repository.delete performs a direct DELETE and returns the affected count.
    const result = await this.tasksRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }
  }

  async findByStatus(status: TaskStatus): Promise<Task[]> {
    // Use repository helper to keep code DB-agnostic and include relations
    return this.tasksRepository.find({
      where: { status },
      relations: ['user'],
      order: { dueDate: 'ASC' },
    });
  }

  async updateStatus(id: string, status: string): Promise<Task> {
    // This method will be called by the task processor.
    // Use a direct update for efficiency and then return the refreshed entity.
    const result = await this.tasksRepository.update(id, { status: status as any });
    if (result.affected === 0) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }

    // Return the updated task (including relations) for any downstream processing.
    return this.findOne(id);
  }
}
