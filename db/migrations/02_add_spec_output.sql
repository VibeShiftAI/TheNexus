-- Add spec_output column to features table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'features' AND column_name = 'spec_output') THEN
        ALTER TABLE features ADD COLUMN spec_output TEXT;
    END IF;
END $$;
