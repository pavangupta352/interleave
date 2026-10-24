import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/** Buy the last unit of stock. Safe: one conditional update decides whether the purchase happens. */
public class CheckoutSafe {
    public static void main(String[] args) throws SQLException {
        String url = "jdbc:postgresql://" + System.getenv("PGHOST") + ":" + System.getenv("PGPORT") + "/" + System.getenv("PGDATABASE");
        try (Connection db = DriverManager.getConnection(url, System.getenv("PGUSER"), System.getenv("PGPASSWORD"))) {
            db.setAutoCommit(false);
            boolean bought;
            try (PreparedStatement update = db.prepareStatement("UPDATE product SET stock = stock - 1 WHERE id = ? AND stock > 0 RETURNING stock")) {
                update.setInt(1, 1);
                try (ResultSet rows = update.executeQuery()) {
                    bought = rows.next();
                }
            }
            if (bought) {
                try (PreparedStatement insert = db.prepareStatement("INSERT INTO orders (product_id) VALUES (?)")) {
                    insert.setInt(1, 1);
                    insert.executeUpdate();
                }
            }
            db.commit();
            System.out.println("{\"bought\":" + bought + "}");
        }
    }
}
