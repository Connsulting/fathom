import { defineConfig } from '@playwright/test';
import config from './playwright.config.mjs';

export default defineConfig({ ...config, testMatch: 'public-demo.spec.mjs', webServer: undefined });
