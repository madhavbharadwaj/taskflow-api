import { utilities as nestWinstonModuleUtilities, WinstonModule, WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';

export const getLoggerOptions = (): WinstonModuleOptions => {
  const isProduction = process.env.NODE_ENV === 'production';

  // Define log format with correlation ID
  const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
  );

  // Console format for development
  const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.ms(),
    nestWinstonModuleUtilities.format.nestLike('TaskFlow', {
      colors: true,
      prettyPrint: true,
    }),
  );

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: isProduction ? logFormat : consoleFormat,
    }),
  ];

  // Add file transports in production
  if (isProduction) {
    transports.push(
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        format: logFormat,
      }),
      new winston.transports.File({
        filename: 'logs/combined.log',
        format: logFormat,
      }),
    );
  }

  return {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    format: logFormat,
    transports,
    // Default metadata added to all logs
    defaultMeta: {
      service: 'taskflow-api',
      environment: process.env.NODE_ENV || 'development',
      instance: process.env.INSTANCE_ID || process.env.HOSTNAME || 'local',
    },
  };
};

export const createLogger = () => {
  return WinstonModule.createLogger(getLoggerOptions());
};
