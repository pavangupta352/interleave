import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/** Buy the last unit of stock. Unsafe: the stock check and the update are separate statements. */
public class Checkout {
    public static void main(String[] args) throws SQLException {
        String url = "jdbc:postgresql://" + System.getenv("PGHOST") + ":" + System.getenv("PGPORT") + "/" + System.getenv("PGDATABASE");
        try (Connection db = DriverManager.getConnection(url, System.getenv("PGUSER"), System.getenv("PGPASSWORD"))) {
            int stock;
            try (PreparedStatement select = db.prepareStatement("SELECT stock FROM product WHERE id = ?")) {
                select.setInt(1, 1);
                try (ResultSet rows = select.executeQuery()) {
                    rows.next();
                    stock = rows.getInt(1);
                }
            }
            if (stock > 0) {
                try (PreparedStatement update = db.prepareStatement("UPDATE product SET stock = ? WHERE id = ?")) {
                    update.setInt(1, stock - 1);
                    update.setInt(2, 1);
                    update.executeUpdate();
                }
                try (PreparedStatement insert = db.prepareStatement("INSERT INTO orders (product_id) VALUES (?)")) {
                    insert.setInt(1, 1);
                    insert.executeUpdate();
                }
            }
            System.out.println("{\"saw_stock\":" + stock + ",\"bought\":" + (stock > 0) + "}");
        }
    }
}
