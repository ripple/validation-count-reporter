import {Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable} from "typeorm";
import {Validation} from "./Validation";

@Entity()
export class Amendment {

    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    firstName: string;

    @Column()
    lastName: string;

    @Column()
    age: number;

    @ManyToMany(type => Validation, validation => validation.amendments)
    @JoinTable()
    validations: Validation[];
}
