import java.io.StringReader;
import java.io.StringWriter;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import org.postgresql.PGConnection;
import org.postgresql.copy.CopyManager;

/** pgjdbc's fetch-size cursor, query timeout and CopyManager through one actor connection. */
public class ProtocolFeatures {
    public static void main(String[] args) throws Exception {
        String url = "jdbc:postgresql://" + System.getenv("PGHOST") + ":" + System.getenv("PGPORT") + "/" + System.getenv("PGDATABASE");
        try (Connection db = DriverManager.getConnection(url, System.getenv("PGUSER"), System.getenv("PGPASSWORD"))) {
            // pgjdbc reads a query in batches of the fetch size only inside a transaction.
            db.setAutoCommit(false);
            StringBuilder ids = new StringBuilder();
            try (Statement cursor = db.createStatement()) {
                cursor.setFetchSize(2);
                try (ResultSet rows = cursor.executeQuery("SELECT id FROM items ORDER BY id")) {
                    while (rows.next()) ids.append(ids.length() == 0 ? "" : ",").append(rows.getInt(1));
                }
            }
            db.commit();
            db.setAutoCommit(true);
            // A query timeout sends PostgreSQL a cancel request from pgjdbc's timer thread.
            String timeout;
            try (Statement slow = db.createStatement()) {
                slow.setQueryTimeout(1);
                slow.execute("SELECT pg_sleep(30)");
                timeout = "completed";
            } catch (SQLException error) {
                timeout = error.getSQLState();
            }
            CopyManager copy = db.unwrap(PGConnection.class).getCopyAPI();
            long copied = copy.copyIn("COPY items (id) FROM STDIN", new StringReader("6\n7\n"));
            StringWriter out = new StringWriter();
            copy.copyOut("COPY (SELECT id FROM items ORDER BY id) TO STDOUT", out);
            System.out.println("{\"ids\":[" + ids + "],\"timeout\":\"" + timeout + "\",\"copied\":" + copied
                + ",\"out\":\"" + out.toString().replace("\n", " ").trim() + "\"}");
        }
    }
}
