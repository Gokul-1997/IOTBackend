module.exports = {
  apps: [
    {
      name: "iot-app",
      script: "src/app.js",
      instances: "max",
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
