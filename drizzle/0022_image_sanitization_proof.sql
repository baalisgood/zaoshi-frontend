ALTER TABLE `assets` ADD COLUMN `sanitization_version` text;
--> statement-breakpoint
ALTER TABLE `generation_output_commits` ADD COLUMN `sanitization_version` text;
--> statement-breakpoint
CREATE TRIGGER `assets_sanitization_version_immutable`
BEFORE UPDATE OF `sanitization_version` ON `assets`
WHEN NEW.`sanitization_version` IS NOT OLD.`sanitization_version`
BEGIN SELECT RAISE(ABORT, 'asset sanitization version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_output_sanitization_version_immutable`
BEFORE UPDATE OF `sanitization_version` ON `generation_output_commits`
WHEN NEW.`sanitization_version` IS NOT OLD.`sanitization_version`
BEGIN SELECT RAISE(ABORT, 'output sanitization version is immutable'); END;
