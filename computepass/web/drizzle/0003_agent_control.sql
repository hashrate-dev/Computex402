CREATE TABLE `agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`task_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_events_created` ON `agent_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `agent_heartbeats` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`wallet_address` text NOT NULL,
	`balance_atomic` text,
	`local_budget` text,
	`version` text,
	`last_error` text,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`paused` integer DEFAULT 1 NOT NULL,
	`max_per_purchase_atomic` text,
	`max_per_day_atomic` text,
	`max_units_per_redeem` integer,
	`allowed_offers` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`units` integer NOT NULL,
	`model` text,
	`status` text NOT NULL,
	`voucher_id` text,
	`units_used` integer,
	`paid_atomic` text,
	`result_text` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `agent_tasks_status_created` ON `agent_tasks` (`status`,`created_at`);