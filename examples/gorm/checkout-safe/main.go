// Command checkout-safe buys the last unit of stock with GORM. Safe: the product
// is read with SELECT ... FOR UPDATE inside a transaction, so the second purchase
// waits for the first to commit and then reads the stock it left.
package main

import (
	"encoding/json"
	"log"
	"os"

	"example.com/gorm-checkout/shop"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func main() {
	db, err := shop.Open()
	if err != nil {
		log.Fatal(err)
	}
	bought := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var product shop.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&product, 1).Error; err != nil {
			return err
		}
		if product.Stock == 0 {
			return nil
		}
		bought = true
		if err := tx.Model(&product).Update("stock", product.Stock-1).Error; err != nil {
			return err
		}
		return tx.Create(&shop.Order{ProductID: 1}).Error
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Bought bool `json:"bought"`
	}{bought}); err != nil {
		log.Fatal(err)
	}
}
