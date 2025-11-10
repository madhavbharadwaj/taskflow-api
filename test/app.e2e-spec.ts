import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

jest.setTimeout(600000);

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Apply the same pipes used in the main application
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('/ (GET) - should be protected', () => {
    return request(app.getHttpServer()).get('/').expect(401);
  });

  describe('Auth Module (e2e)', () => {
    const testUser = {
      email: `test-${Date.now()}@example.com`,
      password: 'Test123!@#',
      name: 'Test User',
    };

    let authToken: string;

    it('/auth/register (POST) - should register a new user', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send(testUser)
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('access_token');
          expect(res.body).toHaveProperty('user');
          expect(res.body.user.email).toBe(testUser.email);
          expect(res.body.user).not.toHaveProperty('password');
          authToken = res.body.access_token;
        });
    });

    it('/auth/register (POST) - should fail with duplicate email', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send(testUser)
        .expect(400);
    });

    it('/auth/register (POST) - should fail with invalid email', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'invalid-email',
          password: 'Test123!@#',
          name: 'Test User',
        })
        .expect(400);
    });

    it('/auth/login (POST) - should login with valid credentials', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('access_token');
          expect(res.body).toHaveProperty('user');
          authToken = res.body.access_token;
        });
    });

    it('/auth/login (POST) - should fail with invalid credentials', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: 'wrongpassword',
        })
        .expect(401);
    });

    it('/auth/login (POST) - should fail with non-existent user', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'Test123!@#',
        })
        .expect(401);
    });
  });

  describe('Tasks Module (e2e)', () => {
    let authToken: string;
    let userId: string;
    let createdTaskId: string;

    beforeAll(async () => {
      // Register a user for task tests
      const testUser = {
        email: `tasktest-${Date.now()}@example.com`,
        password: 'Test123!@#',
        name: 'Task Test User',
      };

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send(testUser);

      authToken = registerResponse.body.access_token;
      userId = registerResponse.body.user.id;
    });

    describe('POST /tasks', () => {
      it('should create a new task', () => {
        const createTaskDto = {
          title: 'Test Task',
          description: 'Test Description',
          status: 'PENDING',
          priority: 'MEDIUM',
          dueDate: '2024-12-31T23:59:59Z',
          userId: userId,
        };

        return request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${authToken}`)
          .send(createTaskDto)
          .expect(201)
          .expect((res) => {
            expect(res.body).toHaveProperty('id');
            expect(res.body.title).toBe(createTaskDto.title);
            expect(res.body.description).toBe(createTaskDto.description);
            expect(res.body.status).toBe(createTaskDto.status);
            expect(res.body.priority).toBe(createTaskDto.priority);
            expect(res.body.userId).toBe(userId);
            createdTaskId = res.body.id;
          });
      });

      it('should fail to create task without authentication', () => {
        const createTaskDto = {
          title: 'Test Task',
          userId: userId,
        };

        return request(app.getHttpServer())
          .post('/tasks')
          .send(createTaskDto)
          .expect(401);
      });

      it('should fail to create task with invalid userId', () => {
        const createTaskDto = {
          title: 'Test Task',
          userId: '00000000-0000-0000-0000-000000000000',
        };

        return request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${authToken}`)
          .send(createTaskDto)
          .expect(400);
      });

      it('should fail to create task with missing title', () => {
        const createTaskDto = {
          description: 'Test Description',
          userId: userId,
        };

        return request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${authToken}`)
          .send(createTaskDto)
          .expect(400);
      });

      it('should fail to create task with invalid status', () => {
        const createTaskDto = {
          title: 'Test Task',
          status: 'INVALID_STATUS',
          userId: userId,
        };

        return request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${authToken}`)
          .send(createTaskDto)
          .expect(400);
      });

      it('should fail to create task with invalid priority', () => {
        const createTaskDto = {
          title: 'Test Task',
          priority: 'INVALID_PRIORITY',
          userId: userId,
        };

        return request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${authToken}`)
          .send(createTaskDto)
          .expect(400);
      });
    });

    describe('GET /tasks', () => {
      it('should retrieve all tasks', () => {
        return request(app.getHttpServer())
          .get('/tasks')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body).toHaveProperty('data');
            expect(res.body).toHaveProperty('count');
            expect(res.body).toHaveProperty('page');
            expect(res.body).toHaveProperty('limit');
            expect(Array.isArray(res.body.data)).toBe(true);
          });
      });

      it('should filter tasks by status', () => {
        return request(app.getHttpServer())
          .get('/tasks?status=PENDING')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.data).toBeInstanceOf(Array);
            res.body.data.forEach((task: any) => {
              expect(task.status).toBe('PENDING');
            });
          });
      });

      it('should filter tasks by priority', () => {
        return request(app.getHttpServer())
          .get('/tasks?priority=MEDIUM')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.data).toBeInstanceOf(Array);
            res.body.data.forEach((task: any) => {
              expect(task.priority).toBe('MEDIUM');
            });
          });
      });

      it('should paginate tasks', () => {
        return request(app.getHttpServer())
          .get('/tasks?page=1&limit=5')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.page).toBe(1);
            expect(res.body.limit).toBe(5);
            expect(res.body.data.length).toBeLessThanOrEqual(5);
          });
      });

      it('should fail without authentication', () => {
        return request(app.getHttpServer())
          .get('/tasks')
          .expect(401);
      });
    });

    describe('GET /tasks/stats', () => {
      it('should retrieve task statistics', () => {
        return request(app.getHttpServer())
          .get('/tasks/stats')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body).toHaveProperty('total');
            expect(res.body).toHaveProperty('completed');
            expect(res.body).toHaveProperty('inProgress');
            expect(res.body).toHaveProperty('pending');
            expect(res.body).toHaveProperty('highPriority');
            expect(typeof res.body.total).toBe('number');
          });
      });

      it('should fail without authentication', () => {
        return request(app.getHttpServer())
          .get('/tasks/stats')
          .expect(401);
      });
    });

    describe('GET /tasks/:id', () => {
      it('should retrieve a task by id', () => {
        return request(app.getHttpServer())
          .get(`/tasks/${createdTaskId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.id).toBe(createdTaskId);
            expect(res.body).toHaveProperty('title');
            expect(res.body).toHaveProperty('status');
            expect(res.body).toHaveProperty('priority');
          });
      });

      it('should return 404 for non-existent task', () => {
        return request(app.getHttpServer())
          .get('/tasks/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(404);
      });

      it('should return 400 for invalid UUID format', () => {
        return request(app.getHttpServer())
          .get('/tasks/invalid-uuid')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(400);
      });

      it('should fail without authentication', () => {
        return request(app.getHttpServer())
          .get(`/tasks/${createdTaskId}`)
          .expect(401);
      });
    });

    describe('PATCH /tasks/:id', () => {
      it('should update a task', () => {
        const updateTaskDto = {
          title: 'Updated Task Title',
          status: 'IN_PROGRESS',
          priority: 'HIGH',
        };

        return request(app.getHttpServer())
          .patch(`/tasks/${createdTaskId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .send(updateTaskDto)
          .expect(200)
          .expect((res) => {
            expect(res.body.title).toBe(updateTaskDto.title);
            expect(res.body.status).toBe(updateTaskDto.status);
            expect(res.body.priority).toBe(updateTaskDto.priority);
          });
      });

      it('should update task status only', () => {
        const updateTaskDto = {
          status: 'COMPLETED',
        };

        return request(app.getHttpServer())
          .patch(`/tasks/${createdTaskId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .send(updateTaskDto)
          .expect(200)
          .expect((res) => {
            expect(res.body.status).toBe(updateTaskDto.status);
          });
      });

      it('should return 404 for non-existent task', () => {
        return request(app.getHttpServer())
          .patch('/tasks/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ title: 'Updated Title' })
          .expect(404);
      });

      it('should return 400 for invalid UUID format', () => {
        return request(app.getHttpServer())
          .patch('/tasks/invalid-uuid')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ title: 'Updated Title' })
          .expect(400);
      });

      it('should fail with invalid status', () => {
        return request(app.getHttpServer())
          .patch(`/tasks/${createdTaskId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .send({ status: 'INVALID_STATUS' })
          .expect(400);
      });

      it('should fail without authentication', () => {
        return request(app.getHttpServer())
          .patch(`/tasks/${createdTaskId}`)
          .send({ title: 'Updated Title' })
          .expect(401);
      });
    });

    describe('DELETE /tasks/:id', () => {
      let taskToDelete: string;

      beforeAll(async () => {
        // Create a task to delete
        const createResponse = await request(app.getHttpServer())
          .post('/tasks')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            title: 'Task to Delete',
            userId: userId,
          });

        taskToDelete = createResponse.body.id;
      });

      it('should delete a task', () => {
        return request(app.getHttpServer())
          .delete(`/tasks/${taskToDelete}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body).toHaveProperty('message');
            expect(res.body.message).toBe('Task deleted successfully');
          });
      });

      it('should return 404 for already deleted task', () => {
        return request(app.getHttpServer())
          .delete(`/tasks/${taskToDelete}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(404);
      });

      it('should return 404 for non-existent task', () => {
        return request(app.getHttpServer())
          .delete('/tasks/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(404);
      });

      it('should return 400 for invalid UUID format', () => {
        return request(app.getHttpServer())
          .delete('/tasks/invalid-uuid')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(400);
      });

      it('should fail without authentication', () => {
        return request(app.getHttpServer())
          .delete(`/tasks/${createdTaskId}`)
          .expect(401);
      });
    });

    describe('Search and Filter (e2e)', () => {
      beforeAll(async () => {
        // Create multiple tasks for search testing
        const tasks = [
          {
            title: 'Important Project',
            description: 'Critical project deadline',
            status: 'PENDING',
            priority: 'HIGH',
            userId: userId,
          },
          {
            title: 'Team Meeting',
            description: 'Weekly standup',
            status: 'IN_PROGRESS',
            priority: 'LOW',
            userId: userId,
          },
          {
            title: 'Code Review',
            description: 'Review pull requests',
            status: 'COMPLETED',
            priority: 'MEDIUM',
            userId: userId,
          },
        ];

        for (const task of tasks) {
          await request(app.getHttpServer())
            .post('/tasks')
            .set('Authorization', `Bearer ${authToken}`)
            .send(task);
        }
      });

      it('should search tasks by title', () => {
        return request(app.getHttpServer())
          .get('/tasks?search=Project')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.data.length).toBeGreaterThan(0);
            const hasProject = res.body.data.some((task: any) => 
              task.title.toLowerCase().includes('project')
            );
            expect(hasProject).toBe(true);
          });
      });

      it('should search tasks by description', () => {
        return request(app.getHttpServer())
          .get('/tasks?search=deadline')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.data.length).toBeGreaterThan(0);
          });
      });

      it('should filter by userId', () => {
        return request(app.getHttpServer())
          .get(`/tasks?userId=${userId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
          .expect((res) => {
            res.body.data.forEach((task: any) => {
              expect(task.userId).toBe(userId);
            });
          });
      });
    });
  });
});
