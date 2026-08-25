-- 0035_tickets_sin_pdf_url.sql
-- Columna muerta: nunca se llegó a implementar la generación de PDF del
-- ticket, no se referencia en ningún lado del código.
ALTER TABLE tickets DROP COLUMN IF EXISTS pdf_url;
