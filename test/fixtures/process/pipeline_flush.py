import json
import os

from psycopg import pq

# libpq pipeline mode: queries queue without Sync; PQsendFlushRequest asks the
# server to send what it has, and PQpipelineSync ends the cycle.
conn = pq.PGconn.connect(os.environ["DATABASE_URL"].encode())
assert conn.status == pq.ConnStatus.OK, conn.error_message
conn.enter_pipeline_mode()
conn.send_query_params(b"UPDATE items SET value = value + 1 WHERE id = $1 RETURNING value", [b"1"])
conn.send_query_params(b"SELECT sum(value) FROM items", None)
conn.send_flush_request()
assert conn.flush() == 0
values = []
for _ in range(2):
    result = conn.get_result()
    assert result is not None and result.status == pq.ExecStatus.TUPLES_OK, result and result.status
    values.append(int(result.get_value(0, 0)))
    assert conn.get_result() is None
conn.pipeline_sync()
result = conn.get_result()
assert result is not None and result.status == pq.ExecStatus.PIPELINE_SYNC, result and result.status
conn.exit_pipeline_mode()
conn.finish()
print(json.dumps(values))
