<?php
// Buy the last unit of stock. Unsafe: the stock check and the update are separate statements.
ini_set('display_errors', 'stderr'); // stdout carries only the JSON result
$dsn = sprintf('pgsql:host=%s;port=%s;dbname=%s;sslmode=disable', getenv('PGHOST'), getenv('PGPORT'), getenv('PGDATABASE'));
$db = new PDO($dsn, getenv('PGUSER'), getenv('PGPASSWORD'));

// Run one prepared statement and return its first row, or false. PDO closes the
// server-side statement when $statement is released on return.
function first_row(PDO $db, string $sql, array $params): array|false
{
    $statement = $db->prepare($sql);
    $statement->execute($params);
    return $statement->fetch(PDO::FETCH_NUM);
}

$stock = (int) first_row($db, 'SELECT stock FROM product WHERE id = ?', [1])[0];
if ($stock > 0) {
    first_row($db, 'UPDATE product SET stock = ? WHERE id = ?', [$stock - 1, 1]);
    first_row($db, 'INSERT INTO orders (product_id) VALUES (?)', [1]);
}
echo json_encode(['saw_stock' => $stock, 'bought' => $stock > 0]), "\n";
