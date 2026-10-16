CREATE TABLE `redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`voucher_id` text NOT NULL,
	`units` integer NOT NULL,
	`prompt_hash` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`voucher_id`) REFERENCES `vouchers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vouchers` (
	`id` text PRIMARY KEY NOT NULL,
	`offer_id` text NOT NULL,
	`owner_address` text NOT NULL,
	`total_units` integer NOT NULL,
	`remaining_units` integer NOT NULL,
	`payment_nonce` text NOT NULL,
	`payment_tx` text NOT NULL,
	`contract_token_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_payment_nonce_unique` ON `vouchers` (`payment_nonce`);--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_payment_tx_unique` ON `vouchers` (`payment_tx`);