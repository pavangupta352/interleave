import json
import os

import psycopg
from psycopg import pq

url = os.environ["DATABASE_URL"]
# psycopg's copy() sends a simple query.
with psycopg.connect(url, autocommit=True) as connection:
    with connection.cursor() as cursor:
        with cursor.copy("COPY items (id, name) FROM STDIN") as copy:
            copy.write("1\tapple\n2\tpear\n")

# libpq's PQsendQueryParams uses the extended protocol; PQputCopyEnd then sends
# CopyDone and the Sync that completes the cycle.
raw = pq.PGconn.connect(url.encode())
assert raw.status == pq.ConnStatus.OK, raw.error_message
raw.send_query_params(b"COPY items (id, name) FROM STDIN", None)
started = raw.get_result()
assert started is not None and started.status == pq.ExecStatus.COPY_IN, started and started.status
assert raw.put_copy_data(b"3\tplum\n") == 1
assert raw.put_copy_end() == 1
finished = raw.get_result()
assert finished is not None and finished.status == pq.ExecStatus.COMMAND_OK, raw.error_message
assert raw.get_result() is None
raw.finish()

# Binary COPY: the proxy moves and measures the bytes without reading them.
with psycopg.connect(url, autocommit=True) as connection:
    with connection.cursor() as cursor:
        with cursor.copy("COPY items (id, name) FROM STDIN (FORMAT BINARY)") as copy:
            copy.set_types(["int4", "text"])
            copy.write_row((4, "fig"))

with psycopg.connect(url, autocommit=True) as connection:
    with connection.cursor() as cursor:
        with cursor.copy("COPY (SELECT id, name FROM items ORDER BY id) TO STDOUT") as copy:
            data = b"".join(bytes(chunk) for chunk in copy)
print(json.dumps(data.decode()))
