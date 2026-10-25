// Package shop maps the scenario's tables to GORM models and opens the actor's own endpoint.
package shop

import (
	"os"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type Product struct {
	ID    int
	Stock int
}

func (Product) TableName() string { return "product" }

type Order struct {
	ID        int
	ProductID int
}

func (Order) TableName() string { return "orders" }

// Open connects to DATABASE_URL, the endpoint Interleave gives this actor.
func Open() (*gorm.DB, error) {
	return gorm.Open(postgres.Open(os.Getenv("DATABASE_URL")), &gorm.Config{Logger: logger.Discard})
}
