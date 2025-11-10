import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, HttpException, HttpStatus, UseInterceptors } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskFilterDto } from './dto/task-filter.dto';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags, ApiBody, ApiResponse } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Task } from './entities/task.entity';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(JwtAuthGuard, RateLimitGuard)
@RateLimit({ limit: 100, windowMs: 60000 })
@ApiBearerAuth()
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    // Anti-pattern: Controller directly accessing repository
    @InjectRepository(Task)
    private taskRepository: Repository<Task>
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  create(@Body() createTaskDto: CreateTaskDto) {
    return this.tasksService.create(createTaskDto);
  }

  @Get()
  @ApiOperation({ summary: 'Find all tasks with optional filtering' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (starts from 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Number of items per page' })
  @ApiQuery({ name: 'status', required: false, enum: TaskStatus, description: 'Filter by task status' })
  @ApiQuery({ name: 'priority', required: false, enum: TaskPriority, description: 'Filter by task priority' })
  async findAll(@Query() filter: TaskFilterDto): Promise<{ 
    data: Task[]; 
    count: number; 
    page: number; 
    limit: number;
  }> {
    try {
      const { data, count } = await this.tasksService.findAll(filter);
      const page = Math.max(1, filter?.page || 1);
      const limit = Math.min(100, Math.max(1, filter?.limit || 10));

      return {
        data,
        count,
        page,
        limit,
      };
    } catch (error) {
      throw new HttpException(
        'Failed to retrieve tasks',
        error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get task statistics' })
  async getStats() {
    try {
      const [
        totalCount,
        statusCounts,
        priorityCounts
      ] = await Promise.all([
        this.taskRepository.count(),
        this.taskRepository
          .createQueryBuilder('task')
          .select('task.status', 'status')
          .addSelect('COUNT(*)', 'count')
          .groupBy('task.status')
          .getRawMany(),
        this.taskRepository
          .createQueryBuilder('task')
          .select('task.priority', 'priority')
          .addSelect('COUNT(*)', 'count')
          .groupBy('task.priority')
          .getRawMany()
      ]);

      const statusMap = statusCounts.reduce((acc, { status, count }) => {
        acc[status.toLowerCase()] = parseInt(count);
        return acc;
      }, {});

      const statistics = {
        total: totalCount,
        completed: statusMap['completed'] || 0,
        inProgress: statusMap['in_progress'] || 0,
        pending: statusMap['pending'] || 0,
        highPriority: priorityCounts.find(p => p.priority === TaskPriority.HIGH)?.count || 0
      };

      return statistics;
    } catch (error) {
      throw new HttpException(
        'Failed to retrieve task statistics',
        error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Find a task by ID' })
  async findOne(@Param('id') id: string): Promise<Task> {
    try {
      // Validate UUID format (any version)
      console.log('Fetching task with ID:', id);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new HttpException('Invalid task ID format', HttpStatus.BAD_REQUEST);
      }

      const task = await this.tasksService.findOne(id);
      
      if (!task) {
        throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
      }
      
      return task;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to retrieve task',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a task' })
  async update(
    @Param('id') id: string,
    @Body() updateTaskDto: UpdateTaskDto
  ): Promise<Task> {
    try {
      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new HttpException('Invalid task ID format', HttpStatus.BAD_REQUEST);
      }

      // Check if task exists
      const existingTask = await this.tasksService.findOne(id);
      if (!existingTask) {
        throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
      }

      // Perform the update
      const updatedTask = await this.tasksService.update(id, updateTaskDto);
      if (!updatedTask) {
        throw new HttpException('Failed to update task', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      return updatedTask;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to update task',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task' })
  async remove(@Param('id') id: string): Promise<{ message: string; statusCode: number }> {
    try {
      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new HttpException('Invalid task ID format', HttpStatus.BAD_REQUEST);
      }

      // Check if task exists before attempting to delete
      const existingTask = await this.tasksService.findOne(id);
      if (!existingTask) {
        throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
      }

      // Perform the deletion
      await this.tasksService.remove(id);

      return {
        message: 'Task deleted successfully',
        statusCode: HttpStatus.OK
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to delete task',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('batch')
  @ApiOperation({ 
    summary: 'Batch process multiple tasks',
    description: 'Perform bulk operations (complete/delete) on multiple tasks'
  })
  @ApiBody({
    description: 'Batch operation payload',
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
        },
        action: {
          type: 'string',
          enum: ['complete', 'delete'],
        },
      },
      example: {
        tasks: [
          '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          '2b4f6e89-4f5d-4b2a-9e6b-3c1f0a9d5d9a'
        ],
        action: 'complete'
      }
    }
  })
  @ApiResponse({
    status: 200,
    description: 'Batch operation results',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          success: { type: 'boolean' },
          message: { type: 'string' }
        }
      }
    }
  })
  async batchProcess(
    @Body() operations: { 
      tasks: string[],
      action: 'complete' | 'delete'
    }
  ): Promise<Array<{ taskId: string; success: boolean; message?: string }>> {
    try {
      const { tasks: taskIds, action } = operations;

      // Validate input
      if (!taskIds?.length) {
        throw new HttpException('No tasks provided', HttpStatus.BAD_REQUEST);
      }

      // Validate all task IDs first
      const invalidIds = taskIds.filter(
        id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      );
      if (invalidIds.length > 0) {
        throw new HttpException(
          'Invalid task ID format detected',
          HttpStatus.BAD_REQUEST
        );
      }

      // Validate action
      if (!['complete', 'delete'].includes(action)) {
        throw new HttpException(
          'Invalid action. Supported actions: complete, delete',
          HttpStatus.BAD_REQUEST
        );
      }

      // Find all tasks in one query using In operator
      const existingTasks = await this.taskRepository.findBy({
        id: In(taskIds)
      });
      const existingTaskIds = new Set(existingTasks.map(task => task.id));

      // Process tasks in bulk based on action
      if (action === 'complete') {
        await this.taskRepository
          .createQueryBuilder()
          .update(Task)
          .set({ status: TaskStatus.COMPLETED })
          .whereInIds(taskIds)
          .execute();
      } else if (action === 'delete') {
        await this.taskRepository
          .createQueryBuilder()
          .delete()
          .whereInIds(taskIds)
          .execute();
      }

      // Prepare results
      return taskIds.map(taskId => ({
        taskId,
        success: existingTaskIds.has(taskId),
        message: existingTaskIds.has(taskId)
          ? `Task ${action === 'complete' ? 'completed' : 'deleted'} successfully`
          : 'Task not found'
      }));

    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to process batch operation',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
} 