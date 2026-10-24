<?php
// Buy the last unit of stock. Safe: one conditional update decides whether the purchase happens.
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

$db->beginTransaction();
$bought = first_row($db, 'UPDATE product SET stock = stock - 1 WHERE id = ? AND stock > 0 RETURNING stock', [1]) !== false;
if ($bought) {
    first_row($db, 'INSERT INTO orders (product_id) VALUES (?)', [1]);
}
$db->commit();
echo json_encode(['bought' => $bought]), "\n";
