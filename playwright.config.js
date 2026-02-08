import { defineConfig } from "@playwright/test";

export default defineConfig({
    timeout: 3 * 60 * 1000,
    use: {
        headless: true,
        screenshot: "only-on-failure",
        trace: "retain-on-failure"
    }
});
