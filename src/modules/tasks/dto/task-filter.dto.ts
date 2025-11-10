import { ApiProperty } from '@nestjs/swagger';
import { TaskStatus } from '../enums/task-status.enum';
import { TaskPriority } from '../enums/task-priority.enum';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO used to filter tasks in list endpoints.
 * Supports filtering by status, priority, owner, free-text search and date ranges.
 */
export class TaskFilterDto {
  @ApiProperty({ enum: TaskStatus, required: false })
  @IsEnum(TaskStatus)
  @IsOptional()
  status?: TaskStatus;

  @ApiProperty({ enum: TaskPriority, required: false })
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000', required: false })
  @IsUUID()
  @IsOptional()
  userId?: string;

  @ApiProperty({ example: 'documentation', required: false })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiProperty({ example: '2023-12-31T23:59:59Z', required: false })
  @IsDateString()
  @IsOptional()
  dueBefore?: string;

  @ApiProperty({ example: '2023-01-01T00:00:00Z', required: false })
  @IsDateString()
  @IsOptional()
  dueAfter?: string;

  @ApiProperty({ example: 1, required: false })
  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiProperty({ example: 10, required: false })
  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}