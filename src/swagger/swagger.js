const swaggerJsDoc  = require('swagger-jsdoc');
const swaggerUi     = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title:       'IoT Manufacturing Platform API',
      version:     '1.0.0',
      description: 'Multi-tenant IoT platform for manufacturing OEE tracking',
    },
    servers: [{ url: '/api', description: 'API server' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type:   'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        }
      }
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth',         description: 'Authentication endpoints' },
      { name: 'Dashboard',    description: 'Dashboard data' },
      { name: 'Machines',     description: 'Machine management' },
      { name: 'OEE',          description: 'OEE reports and metrics' },
      { name: 'Alarms',       description: 'Machine alarms and alerts' },
      { name: 'Downtime',     description: 'Downtime reason codes and events' },
      { name: 'Maintenance',  description: 'Maintenance scheduling and logs' },
      { name: 'Plans',        description: 'Production planning' },
      { name: 'Notifications',description: 'In-app notifications' },
      { name: '2FA',          description: 'Two-factor authentication' },
      { name: 'Reports',      description: 'Export reports (PDF/Excel/CSV)' },
    ]
  },
  apis: ['./src/**/*.routes.js'],
};

const swaggerSpec = swaggerJsDoc(options);

module.exports = (app) => {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'IoT Platform API Docs'
  }));
  app.get('/api-docs.json', (req, res) => res.json(swaggerSpec));
};
