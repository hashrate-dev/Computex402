CREATE TABLE `payments` (
	`nonce` text PRIMARY KEY NOT NULL,
	`voucher_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`payer` text NOT NULL,
	`amount_atomic` text NOT NULL,
	`status` text NOT NULL,
	`payment_tx` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_voucher_id_unique` ON `payments` (`voucher_id`);--> statement-breakpoint
ALTER TABLE `redemptions` ADD `nonce` text;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `reserved_units` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `prompt_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `completion_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `redemptions_nonce_unique` ON `redemptions` (`nonce`);--> statement-breakpoint
INSERT INTO `payments` (`nonce`, `voucher_id`, `offer_id`, `payer`, `amount_atomic`, `status`, `payment_tx`, `error`, `created_at`, `updated_at`)
SELECT `payment_nonce`, `id`, `offer_id`, `owner_address`,
  CASE `offer_id` WHEN 'llama-70b-burst' THEN '10000000000000000' WHEN 'deepseek-r1-flex' THEN '18000000000000000' ELSE '0' END,
  'settled', `payment_tx`, NULL, `issued_at`, `issued_at`
FROM `vouchers` WHERE true ON CONFLICT(`nonce`) DO NOTHING;
