export default class AppService {
  constructor({ config }) {
    this.config = config;
  }

  async getPublicSettings(appId) {
    if (!appId) {
      const error = new Error('App ID is required');
      error.statusCode = 400;
      throw error;
    }

    if (this.config.appId && this.config.appId !== appId) {
      const error = new Error('App ID does not match');
      error.statusCode = 404;
      throw error;
    }

    return {
      id: appId,
      public_settings: {
        ...this.config.publicSettings,
        environment: this.config.env
      }
    };
  }
}
