-- Installed only through an explicitly invoked migration. Once installed, every SQL mutation
-- is captured atomically, including seed/import writes; publishing stays independently opt-in.
ALTER TABLE products ADD COLUMN product_version BIGINT NOT NULL DEFAULT 1 CHECK(product_version BETWEEN 1 AND 9007199254740991);
CREATE TABLE catalog_search_clock (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), sequence BIGINT NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991));
INSERT INTO catalog_search_clock VALUES(TRUE,0);
CREATE TABLE catalog_search_documents (id UUID PRIMARY KEY, version BIGINT NOT NULL, change_sequence BIGINT NOT NULL UNIQUE, document JSONB NOT NULL);
CREATE TABLE catalog_search_changes (sequence BIGINT PRIMARY KEY, document JSONB NOT NULL);
CREATE FUNCTION catalog_capture_search() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE product_record products%ROWTYPE; next_version BIGINT; next_sequence BIGINT; projection JSONB; payload JSONB; envelope JSONB;
 event_id UUID:=gen_random_uuid(); correlation UUID:=gen_random_uuid(); event_type TEXT; occurred TEXT;
BEGIN
 -- This transactional counter serializes allocation AND commit order. No sequence gaps from rollback.
 UPDATE catalog_search_clock SET sequence=sequence+1 WHERE singleton RETURNING sequence INTO next_sequence;
 IF TG_OP='DELETE' THEN product_record:=OLD; ELSE product_record:=NEW; END IF;
 SELECT version+1 INTO next_version FROM catalog_search_documents WHERE id=product_record.id;
 next_version:=COALESCE(next_version,1);
 IF TG_OP<>'DELETE' THEN NEW.product_version:=next_version; product_record.product_version:=next_version; END IF;
 IF TG_OP='UPDATE' OR TG_OP='DELETE' THEN product_record.updated_at:=clock_timestamp(); END IF;
 IF TG_OP='UPDATE' THEN NEW.updated_at:=product_record.updated_at; END IF;
 occurred:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 projection:=jsonb_build_object('id',product_record.id,'productVersion',next_version,'name',product_record.name,
 'description',left(product_record.description,20000),'priceInPaise',product_record.price_in_paise,
 'createdAt',to_char(product_record.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(product_record.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'deleted',TG_OP='DELETE');
 INSERT INTO catalog_search_documents VALUES(product_record.id,next_version,next_sequence,projection)
 ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,change_sequence=EXCLUDED.change_sequence,document=EXCLUDED.document;
 INSERT INTO catalog_search_changes VALUES(next_sequence,projection);
 event_type:='catalog.product.'||CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END;
 payload:=jsonb_build_object('productId',product_record.id,'productVersion',next_version,'changeSequence',next_sequence,'product',projection);
 envelope:=jsonb_build_object('eventId',event_id,'eventType',event_type,'eventVersion',1,'occurredAt',occurred,'producer','catalog-service','correlationId',correlation,'causationId',NULL,'payload',payload);
 INSERT INTO outbox_events(id,aggregate_id,event_type,event_version,routing_key,producer,occurred_at,payload,envelope,correlation_id)
 VALUES(event_id,product_record.id,event_type,1,event_type||'.v1','catalog-service',occurred,payload,envelope,correlation);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER products_search_capture BEFORE INSERT OR UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION catalog_capture_search();
-- Capture existing rows with complete version-1 snapshots, through the same capture path.
UPDATE products SET product_version=product_version;
