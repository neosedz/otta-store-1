// @ts-check
// The whole store comes from @urumi.ai/otta-store. Updating it is a version
// bump in package.json; this file only changes when an upgrade note says so
// (the `template` number below).
import cloudflare from "@astrojs/cloudflare";
import otta from "@urumi.ai/otta-store";
import { defineConfig } from "astro/config";

export default defineConfig({
	adapter: cloudflare(),
	integrations: [
		otta({
			template: 1,
			// Optional build settings (each can instead be a Workers Builds build
			// variable of the same name in capitals; see README.md):
			// emailFrom: "store@mail.example.com",    // OTTA_EMAIL_FROM
			// emailFromName: "Acme Goods",            // OTTA_EMAIL_FROM_NAME
			// extraAllowedHosts: "api.example.com",   // OTTA_EXTRA_ALLOWED_HOSTS
		}),
	],
});
